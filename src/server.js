const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');

const app = express();
app.use(cors());

// 设置更大的请求体限制
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// 存储上传任务状态
const uploadTasks = new Map();

const N8N_WEBHOOK_URL = 'https://flowasitgoes.app.n8n.cloud/webhook-test/youtube-upload-callback';

// Google Drive confirm token 流程
async function getGoogleDriveStream(driveUrl) {
  const urlObj = new URL(driveUrl);
  const fileId = urlObj.searchParams.get('id');
  let url = `https://drive.google.com/uc?export=download&id=${fileId}`;

  // 第一次請求（允許自動跟隨 redirect）
  let res = await fetch(url); // 預設 redirect: 'follow'
  let contentType = res.headers.get('content-type');
  if (contentType && contentType.startsWith('text/html')) {
    // 解析 confirm token
    const text = await res.text();
    console.log('Google Drive HTML:', text.slice(0, 1000));
    const match = text.match(/confirm=([0-9A-Za-z_]+)&/);
    if (!match) throw new Error('找不到 confirm token，無法下載大檔案');
    const confirm = match[1];
    // 第二次請求（允許自動跟隨 redirect）
    url = `https://drive.google.com/uc?export=download&confirm=${confirm}&id=${fileId}`;
    res = await fetch(url); // 預設 redirect: 'follow'
  }
  return res;
}

// Dropbox 連結自動轉換
function normalizeDropboxUrl(url) {
  if (url.includes('dropbox.com')) {
    // 移除舊的 dl 參數，強制加上 dl=1
    if (url.includes('dl=0')) {
      return url.replace('dl=0', 'dl=1');
    } else if (!url.includes('dl=1')) {
      // 沒有 dl 參數，補上 dl=1
      if (url.includes('?')) {
        return url + '&dl=1';
      } else {
        return url + '?dl=1';
      }
    }
  }
  return url;
}

// 异步上传处理函数
async function processUpload(taskId, driveUrl, youtubeUploadUrl, fileType) {
  const startTime = new Date();
  console.log(`[${taskId}] 开始下载时间: ${startTime.toISOString()}`);
  
  try {
    const normalizedDriveUrl = normalizeDropboxUrl(driveUrl);
    const response = normalizedDriveUrl.includes('dropbox.com')
      ? await fetch(normalizedDriveUrl)
      : await getGoogleDriveStream(normalizedDriveUrl);

    if (!response.ok) {
      throw new Error('Failed to fetch from source: ' + response.statusText);
    }

    const contentLength = response.headers.get('content-length');
    let contentType = response.headers.get('content-type');
    if (fileType === 'mov') contentType = 'video/quicktime';
    else if (fileType === 'mp4') contentType = 'video/mp4';
    else if (!contentType || !contentType.startsWith('video/')) contentType = 'video/quicktime';

    const uploadStartTime = new Date();
    console.log(`[${taskId}] 开始上传时间: ${uploadStartTime.toISOString()}`);

    const uploadRes = await fetch(youtubeUploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': contentType,
        ...(contentLength ? { 'Content-Length': contentLength } : {})
      },
      body: response.body,
    });

    const uploadEndTime = new Date();
    console.log(`[${taskId}] 上传结束时间: ${uploadEndTime.toISOString()}`);

    let videoId = null;
    let uploadResJson = null;
    if (uploadRes.ok) {
      try {
        uploadResJson = await uploadRes.json();
        videoId = uploadResJson.id;
      } catch (e) {
        console.error(`[${taskId}] 解析 YouTube 回應失敗:`, e);
      }
    }

    uploadTasks.set(taskId, {
      status: 'completed',
      startTime,
      uploadStartTime,
      uploadEndTime,
      result: 'success',
      videoId
    });

    // POST 給 n8n webhook
    if (videoId) {
      try {
        await fetch(N8N_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            videoId,
            taskId,
            status: 'completed'
          })
        });
        console.log(`[${taskId}] 已通知 n8n webhook，videoId: ${videoId}`);
      } catch (e) {
        console.error(`[${taskId}] 通知 n8n webhook 失敗:`, e);
      }
    }

  } catch (error) {
    console.error(`[${taskId}] 上传失败:`, error);
    uploadTasks.set(taskId, {
      status: 'failed',
      startTime,
      error: error.message
    });
  }
}

app.get('/upload', async (req, res) => {
  const now = new Date();
  const uptimeSec = Math.floor((now - serverStartTime) / 1000);
  let statusMsg = '';
  if (uptimeSec < 60) {
    statusMsg = 'COLD START: 伺服器剛被喚醒';
  } else {
    statusMsg = 'WARM: 伺服器已運作 ' + uptimeSec + ' 秒';
  }
  console.log(`[UPLOAD] ${now.toISOString()} | ${statusMsg}`);

  const { driveUrl, youtubeUploadUrl, fileType } = req.query;

  if (!driveUrl || !youtubeUploadUrl) {
    return res.status(400).send('Missing driveUrl or youtubeUploadUrl');
  }

  const taskId = Date.now().toString();
  console.log(`[${taskId}] 收到新的上传请求`);
  console.log(`[${taskId}] Drive URL:`, driveUrl);
  console.log(`[${taskId}] YouTube Upload URL:`, youtubeUploadUrl);

  // 立即返回任务ID
  res.status(202).json({
    taskId,
    message: 'Upload task started',
    status: 'processing'
  });

  // 异步处理上传
  processUpload(taskId, driveUrl, youtubeUploadUrl, fileType);
});

// 新增状态查询接口
app.get('/status/:taskId', (req, res) => {
  const { taskId } = req.params;
  const task = uploadTasks.get(taskId);
  
  if (!task) {
    return res.status(404).json({
      error: 'Task not found'
    });
  }

  res.json(task);
});

// 健康檢查用 endpoint，讓 Render 的冷啟動有地方回應
app.get('/', (req, res) => {
  res.status(200).send('OK');
});

const serverStartTime = new Date();

app.get('/health', (req, res) => {
  const now = new Date();
  const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
  const userAgent = req.headers['user-agent'] || '';
  const uptimeSec = Math.floor((now - serverStartTime) / 1000);

  let statusMsg = '';
  if (uptimeSec < 60) {
    statusMsg = 'COLD START: 伺服器剛被喚醒';
  } else {
    statusMsg = 'WARM: 伺服器已運作 ' + uptimeSec + ' 秒';
  }

  console.log(`[HEALTH] ${now.toISOString()} | IP: ${ip} | UA: ${userAgent} | ${statusMsg}`);

  res.status(200).json({
    status: 'alive',
    time: now.toISOString(),
    serverStartTime: serverStartTime.toISOString(),
    uptimeSec,
    statusMsg
  });
});

// 測試 webhook 的 POST API
app.post('/test-webhook', (req, res) => {
  res.status(200).json({ message: 'Webhook test started' });

  // 啟動一個定時器，每20秒發送一次假資料
  if (!global.webhookTestInterval) {
    global.webhookTestInterval = setInterval(async () => {
      try {
        const fakeData = {
          videoId: 'Aq8bVuBp04',
          taskId: 'test-task',
          status: 'completed',
          taiwanTimestamp: new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })
        };
        await fetch(N8N_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(fakeData)
        });
        console.log(`[TEST-WEBHOOK] 已發送假資料到 n8n webhook:`, fakeData);
      } catch (e) {
        console.error('[TEST-WEBHOOK] 發送失敗:', e);
      }
    }, 20000);
    console.log('[TEST-WEBHOOK] 測試 webhook 定時器已啟動，每20秒發送一次');
  } else {
    console.log('[TEST-WEBHOOK] 測試 webhook 定時器已存在');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Uploader server running on port ${PORT}`));
