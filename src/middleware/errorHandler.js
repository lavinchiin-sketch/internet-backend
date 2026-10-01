const notFound = (req, res) => res.status(404).json({ message: 'Route not found.' });

// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
  if (err.status) return res.status(err.status).json({ message: err.message, code: err.code });
  if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'That record already exists (duplicate value).' });
  if (err.code === 'ER_NO_REFERENCED_ROW_2') return res.status(400).json({ message: 'A linked record does not exist.' });
  if (err.name === 'MulterError') return res.status(400).json({ message: err.code === 'LIMIT_FILE_SIZE' ? 'File is too large.' : err.message });
  if (err.message === 'That file type is not allowed.') return res.status(400).json({ message: err.message });
  if (err.message === 'Not allowed by CORS') return res.status(403).json({ message: err.message });
  console.error(err);
  res.status(500).json({ message: 'Something went wrong on the server.' });
};
module.exports = { notFound, errorHandler };
