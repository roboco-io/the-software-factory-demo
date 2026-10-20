import { useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router";
import { ApiFailure } from "../api/client";
import type { Errors, User } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { ErrorList } from "../components/ErrorList";

export function Settings() {
  const { user, ready } = useAuth();
  if (ready && !user) return <Navigate to="/login" />;
  if (!user) return null;
  // 사용자 로드가 끝난 뒤 폼을 마운트해야 새로고침 시에도 초기값이 채워진다.
  return <SettingsForm key={user.username} user={user} />;
}

function SettingsForm({ user }: { user: User }) {
  const { client, signIn, signOut } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({
    image: user.image ?? "",
    username: user.username,
    bio: user.bio ?? "",
    email: user.email,
    password: "",
  });
  const [errors, setErrors] = useState<Errors | null>(null);
  const [uploading, setUploading] = useState(false);

  async function pickImage(file: File | undefined) {
    if (!file) return;
    setErrors(null);
    setUploading(true);
    try {
      const r = await client.upload<{ image: string; user: User }>("/user/image", file);
      setForm((f) => ({ ...f, image: r.image }));
      signIn(r.user);
    } catch (err) {
      setErrors(err instanceof ApiFailure ? err.errors : { app: ["failed"] });
    } finally {
      setUploading(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    // 업로드 중 저장하면 이전 이미지 URL이 업로드 결과를 덮어쓴다.
    if (uploading) return;
    setErrors(null);
    const { password, ...rest } = form;
    const payload = password ? { ...rest, password } : rest;
    try {
      const r = await client.put<{ user: User }>("/user", { user: payload });
      signIn(r.user);
      navigate(`/profile/${encodeURIComponent(r.user.username)}`);
    } catch (err) {
      setErrors(err instanceof ApiFailure ? err.errors : { app: ["failed"] });
    }
  }

  return (
    <div className="settings-page">
      <div className="container page">
        <div className="row">
          <div className="col-md-6 offset-md-3 col-xs-12">
            <h1 className="text-xs-center">Your Settings</h1>
            <ErrorList errors={errors} />
            <form onSubmit={submit}>
              <fieldset>
                <fieldset className="form-group">
                  <input
                    className="form-control"
                    type="file"
                    accept="image/png,image/jpeg,image/gif,image/webp"
                    aria-label="Upload profile picture"
                    onChange={(e) => void pickImage(e.target.files?.[0])}
                  />
                </fieldset>
                <fieldset className="form-group">
                  <input
                    className="form-control"
                    placeholder="URL of profile picture"
                    value={form.image}
                    onChange={(e) => setForm({ ...form, image: e.target.value })}
                  />
                </fieldset>
                <fieldset className="form-group">
                  <input
                    className="form-control form-control-lg"
                    placeholder="Your Name"
                    value={form.username}
                    onChange={(e) => setForm({ ...form, username: e.target.value })}
                  />
                </fieldset>
                <fieldset className="form-group">
                  <textarea
                    className="form-control form-control-lg"
                    rows={8}
                    placeholder="Short bio about you"
                    value={form.bio}
                    onChange={(e) => setForm({ ...form, bio: e.target.value })}
                  />
                </fieldset>
                <fieldset className="form-group">
                  <input
                    className="form-control form-control-lg"
                    type="email"
                    placeholder="Email"
                    value={form.email}
                    onChange={(e) => setForm({ ...form, email: e.target.value })}
                  />
                </fieldset>
                <fieldset className="form-group">
                  <input
                    className="form-control form-control-lg"
                    type="password"
                    placeholder="New Password"
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                  />
                </fieldset>
                <button
                  className="btn btn-lg btn-primary pull-xs-right"
                  type="submit"
                  disabled={uploading}
                >
                  Update Settings
                </button>
              </fieldset>
            </form>
            <hr />
            <button
              className="btn btn-outline-danger"
              type="button"
              onClick={() => {
                signOut();
                navigate("/");
              }}
            >
              Or click here to logout.
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
