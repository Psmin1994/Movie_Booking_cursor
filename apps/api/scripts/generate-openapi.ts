import "reflect-metadata";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../dist/app.module.js";
import { buildOpenApiDocument } from "../dist/swagger/swagger.config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function generateOpenApi() {
  const app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix("api");

  const document = buildOpenApiDocument(app);
  const outputPath = resolve(__dirname, "../openapi.json");

  writeFileSync(outputPath, `${JSON.stringify(document, null, 2)}\n`, "utf-8");

  await app.close();

  console.log(`OpenAPI spec written to ${outputPath}`);
}

generateOpenApi().catch((error: unknown) => {
  console.error("Failed to generate OpenAPI spec:", error);
  process.exit(1);
});
