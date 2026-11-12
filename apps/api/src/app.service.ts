import { Injectable } from "@nestjs/common";
import { HealthResponseDto } from "./app/dto/health-response.dto.js";

@Injectable()
export class AppService {
  getHealth(): HealthResponseDto {
    return {
      status: "ok",
      service: "movie-booking-api",
    };
  }
}
