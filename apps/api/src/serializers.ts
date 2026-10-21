type UserRow = { email: string; username: string; bio: string | null; image: string | null };

export const serializeUser = (u: UserRow, token: string) => ({
  email: u.email,
  token,
  username: u.username,
  bio: u.bio,
  image: u.image,
});

// following은 RealWorld 응답 형식의 흔적이다. 팔로우 기능이 없으므로 항상 false다.
export const serializeProfile = (
  u: Pick<UserRow, "username" | "bio" | "image">,
  following: boolean,
) => ({
  username: u.username,
  bio: u.bio,
  image: u.image,
  following,
});
