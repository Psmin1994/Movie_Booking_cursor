import "reflect-metadata";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { configureApp } from "./configure-app.js";
import { setupSwagger } from "./swagger/swagger.config.js";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);
  app.setGlobalPrefix("api");
  configureApp(app);
  setupSwagger(app);
  await app.listen(configService.getOrThrow<number>("app.port"));
}

bootstrap();
