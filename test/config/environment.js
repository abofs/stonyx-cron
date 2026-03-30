export default {
  cron: {
    log: false,
  },
  orm: {
    paths: {
      model: './test/sample/models',
      serializer: './test/sample/serializers',
    },
    db: {
      file: './test/sample/db.json',
      schema: './test/sample/db-schema.js',
    },
    restServer: {
      enabled: 'false',
    },
  },
}
