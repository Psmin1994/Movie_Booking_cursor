export default () => ({
  app: {
    port: Number(process.env.PORT),
    nodeEnv: process.env.NODE_ENV,
    webOrigin: process.env.WEB_ORIGIN,
  },
  auth: {
    jwtSecret: process.env.JWT_SECRET,
    jwtExpiresDays: Number(process.env.JWT_EXPIRES_DAYS),
  },
  database: {
    url: process.env.DATABASE_URL,
  },
  payments: {
    tossSecretKey: process.env.TOSS_PAYMENTS_SECRET_KEY,
  },
});
