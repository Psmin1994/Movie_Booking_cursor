import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module.js";
import { MovieModule } from "../movie/movie.module.js";
import { CreateScreeningService } from "./use-case/create-screening.service.js";
import { GetScreeningSeatsService } from "./use-case/get-screening-seats.service.js";
import { GetScreeningService } from "./use-case/get-screening.service.js";
import { ListScreeningsByMovieAndDateService } from "./use-case/list-screenings-by-movie-and-date.service.js";
import { MovieScreeningsController } from "./controller/movie-screenings.controller.js";
import { ScreeningController } from "./controller/screening.controller.js";
import { ScreeningRepository } from "./repository/screening.repository.js";

@Module({
  imports: [DatabaseModule, MovieModule],
  controllers: [ScreeningController, MovieScreeningsController],
  providers: [
    CreateScreeningService,
    GetScreeningService,
    GetScreeningSeatsService,
    ListScreeningsByMovieAndDateService,
    ScreeningRepository,
  ],
  exports: [ScreeningRepository],
})
export class ScreeningModule {}
