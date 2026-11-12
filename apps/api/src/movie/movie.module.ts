import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module.js";
import { MovieController } from "./controller/movie.controller.js";
import { MovieRepository } from "./repository/movie.repository.js";
import { MovieService } from "./use-case/movie.service.js";

@Module({
  imports: [DatabaseModule],
  controllers: [MovieController],
  providers: [MovieService, MovieRepository],
  exports: [MovieRepository],
})
export class MovieModule {}
