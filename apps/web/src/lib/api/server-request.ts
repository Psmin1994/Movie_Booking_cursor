import { appControllerGetHealth, authControllerGetProfile, movieControllerGetMovie, movieControllerGetMovies } from "@movie-booking/api-client";
import { cookies } from "next/headers";

async function getServerRequestInit(): Promise<RequestInit> {
  const cookieHeader = (await cookies()).toString();

  return {
    headers: cookieHeader ? { Cookie: cookieHeader } : undefined,
  };
}

export async function getHealth() {
  return appControllerGetHealth();
}

export async function getProfile() {
  return authControllerGetProfile(await getServerRequestInit());
}

export async function getMovies() {
  return movieControllerGetMovies();
}

export async function getMovie(id: string) {
  return movieControllerGetMovie(id);
}
