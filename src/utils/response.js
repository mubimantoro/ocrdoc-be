const response = (res, statusCode, message, data) => {
  const body = {
    meta: {
      success: statusCode < 400,
      message,
    },
  };

  if (data !== undefined) body.data = data;

  return res.status(statusCode).json(body);
};

export default response;