const express = require('express');
const got = require('got');
const cors = require('cors');

const app = express();
app.use(cors());

// 设置更大的请求体限制
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

app.get('/upload', async (req, res) => {
  const { driveUrl, youtubeUploadUrl } = req.query;

  if (!driveUrl || !youtubeUploadUrl) {
    return res.status(400).send('Missing driveUrl or youtubeUploadUrl');
  }

  console.log('Starting upload process...');
  console.log('Drive URL:', driveUrl);
  console.log('YouTube Upload URL:', youtubeUploadUrl);

  try {
    const driveStream = got.stream(driveUrl, {
      timeout: {
        request: 600_000 // 10 分鐘下載超時
      }
    });

    let uploadedBytes = 0;
    let lastProgressLog = Date.now();

    driveStream.on('data', (chunk) => {
      uploadedBytes += chunk.length;
      const now = Date.now();
      // 每 5 秒記錄一次進度，避免過多日誌
      if (now - lastProgressLog >= 5000) {
        console.log(`Uploaded ${(uploadedBytes / 1024 / 1024).toFixed(2)} MB`);
        lastProgressLog = now;
      }
    });

    const putResponse = await got.put(youtubeUploadUrl, {
      body: driveStream,
      headers: {
        'Content-Type': 'video/quicktime',
        'Content-Length': driveStream.headers['content-length'] || '0',
        'Transfer-Encoding': 'chunked'
      },
      timeout: {
        request: 1800_000 // 30 分鐘上傳超時
      },
      retry: {
        limit: 5, // 增加重試次數
        methods: ['PUT'],
        statusCodes: [408, 413, 429, 500, 502, 503, 504],
        maxRetryAfter: 10000 // 最多等待 10 秒後重試
      }
    });

    console.log('Upload completed successfully');
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
