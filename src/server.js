const express = require('express');
const fetch = require('node-fetch');
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
    // 取得 Google Drive 檔案的 stream
    const response = await fetch(driveUrl);
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

    // 直接串流 PUT 到 YouTube
    const uploadRes = await fetch(youtubeUploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'video/mp4', // 根據實際格式調整
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
