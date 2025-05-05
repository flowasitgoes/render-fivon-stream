const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');

const app = express();
app.use(cors());

// 设置更大的请求体限制
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

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

app.get('/upload', async (req, res) => {
  const { driveUrl, youtubeUploadUrl, fileType } = req.query;

  if (!driveUrl || !youtubeUploadUrl) {
    return res.status(400).send('Missing driveUrl or youtubeUploadUrl');
  }

  console.log('Starting upload process...');
  console.log('Drive URL:', driveUrl);
  console.log('YouTube Upload URL:', youtubeUploadUrl);

  try {
    // 先處理 Dropbox 連結
    const normalizedDriveUrl = normalizeDropboxUrl(driveUrl);
    // 取得 Google Drive 或 Dropbox 檔案的 stream（自動處理 confirm token）
    const response = normalizedDriveUrl.includes('dropbox.com')
      ? await fetch(normalizedDriveUrl)
      : await getGoogleDriveStream(normalizedDriveUrl);
    console.log('Google Drive response status:', response.status, response.statusText);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Google Drive fetch failed, body:', errorText);
      throw new Error('Failed to fetch from Google Drive: ' + response.statusText);
    }

    console.log('Google Drive response headers:');
    for (const [key, value] of response.headers.entries()) {
      console.log(`${key}: ${value}`);
    }

    // 取得 content-length
    const contentLength = response.headers.get('content-length');

    // 動態決定 Content-Type
    let contentType = response.headers.get('content-type');
    if (fileType === 'mov') contentType = 'video/quicktime';
    else if (fileType === 'mp4') contentType = 'video/mp4';
    else if (!contentType || !contentType.startsWith('video/')) contentType = 'video/mp4';
    console.log('Final upload Content-Type:', contentType);

    // 直接串流 PUT 到 YouTube
    const uploadRes = await fetch(youtubeUploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': contentType,
        ...(contentLength ? { 'Content-Length': contentLength } : {})
      },
      body: response.body,
    });

    if (!uploadRes.ok) {
      const errText = await uploadRes.text();
      throw new Error('Upload failed: ' + errText);
    }

    res.status(200).send('Upload success');
  } catch (err) {
    console.error('Upload failed:', err.message);
    console.error('Error details:', err);
    
    if (err.code === 'ETIMEDOUT') {
      return res.status(504).send('Upload timeout');
    }
    
    if (err.code === 'ECONNRESET') {
      return res.status(503).send('Connection reset, please try again');
    }
    
    res.status(500).send('Upload failed: ' + err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Uploader server running on port ${PORT}`));
