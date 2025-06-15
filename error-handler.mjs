const errorHandler = (err, req, res, next) => {
  console.error(err.stack);

  const statusCode = err.status || 500;
  const message = err.message || '서버에서 오류가 발생했습니다.';

  res.status(statusCode).json({
    status: 'error',
    message,
  });
};

export default errorHandler;
