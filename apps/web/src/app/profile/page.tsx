import { isHttpError, type ProfileResponseDto } from "@movie-booking/api-client";
import { LogoutButton } from "@/features/auth/components/logout-button";
import { getProfile } from "@/lib/api/server-request";
import Link from "next/link";
import { redirect } from "next/navigation";

export default async function ProfilePage() {
  let profile: ProfileResponseDto;

  try {
    const response = await getProfile();
    if (response.status !== 200) {
      redirect("/login");
    }
    profile = response.data;
  } catch (error) {
    if (isHttpError(error)) {
      redirect("/login");
    }

    throw error;
  }

  return (
    <main>
      <h1>내 정보</h1>
      <section className="profile-card">
        <dl>
          <div>
            <dt>id</dt>
            <dd>{profile.id}</dd>
          </div>
          <div>
            <dt>email</dt>
            <dd>{profile.email}</dd>
          </div>
          <div>
            <dt>name</dt>
            <dd>{profile.name}</dd>
          </div>
          <div>
            <dt>createdAt</dt>
            <dd>{profile.createdAt}</dd>
          </div>
        </dl>
      </section>
      <div className="profile-actions">
        <LogoutButton />
        <Link href="/">홈으로</Link>
      </div>
    </main>
  );
}
