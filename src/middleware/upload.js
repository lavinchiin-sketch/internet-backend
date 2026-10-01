// Multipart uploads (attendance photos, documents, task files).
// UPLOAD_DIR must point at a persistent volume in production.
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const uploadDir = path.resolve(process.env.UPLOAD_DIR || 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  },
});

const ALLOWED = /\.(jpe?g|png|webp|pdf|docx?|xlsx?|pptx?|txt|zip)$/i;
const upload = multer({
  storage,
  limits: { fileSize: (Number(process.env.MAX_FILE_SIZE_MB) || 8) * 1024 * 1024 },
  fileFilter: (req, file, cb) => (ALLOWED.test(file.originalname) ? cb(null, true) : cb(new Error('That file type is not allowed.'))),
});

module.exports = { upload, uploadDir };
