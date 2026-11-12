import { INestApplication } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { App } from "supertest/types";
import { AppModule } from "../../src/app.module.js";
import { configureApp } from "../../src/configure-app.js";
import { setupSwagger } from "../../src/swagger/swagger.config.js";

export async function createTestApp(
  customize?: (
    builder: ReturnType<typeof Test.createTestingModule>,
  ) => ReturnType<typeof Test.createTestingModule>,
): Promise<INestApplication<App>> {
  const builder = Test.createTestingModule({
    imports: [AppModule],
  });
  const moduleFixture: TestingModule = await (customize
    ? customize(builder)
    : builder
  ).compile();

  const app = moduleFixture.createNestApplication();
  app.setGlobalPrefix("api");
  configureApp(app);
  setupSwagger(app);
  await app.init();

  return app;
}
