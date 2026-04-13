const response = (res, statusCode, message, data = null, pagination = null) => {
  const payload = {
    meta: {
      success: statusCode >= 200 && statusCode < 300,
      message,
    },
    data
  };

  if (pagination) {
    payload.pagination = pagination;
  }
  return res.status(statusCode).json(payload);
};

export default response;