import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { ApiFailure } from "../api/client";
import type { Errors, Profile as ProfileT } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { ErrorList } from "../components/ErrorList";
import { TopicList } from "../components/TopicList";
import { avatar } from "../lib/avatar";

export function Profile() {
  const { username = "" } = useParams();
  const { client } = useAuth();
  const [profile, setProfile] = useState<ProfileT | null>(null);
  const [errors, setErrors] = useState<Errors | null>(null);

  useEffect(() => {
    client
      .get<{ profile: ProfileT }>(`/profiles/${encodeURIComponent(username)}`)
      .then((r) => setProfile(r.profile))
      .catch((e: unknown) => setErrors(e instanceof ApiFailure ? e.errors : { app: ["failed"] }));
  }, [client, username]);

  if (!profile)
    return (
      <div className="container page">
        <ErrorList errors={errors} />
      </div>
    );
  return (
    <div className="profile-page">
      <div className="user-info">
        <div className="container">
          <div className="row">
            <div className="col-xs-12 col-md-10 offset-md-1">
              <img src={avatar(profile.image)} className="user-img" alt="" />
              <h4>{profile.username}</h4>
              {profile.bio && <p>{profile.bio}</p>}
            </div>
          </div>
        </div>
      </div>
      <div className="container">
        <div className="row">
          <div className="col-xs-12 col-md-10 offset-md-1">
            <div className="articles-toggle">
              <ul className="nav nav-pills outline-active">
                <li className="nav-item">
                  <span className="nav-link active">작성한 토론</span>
                </li>
              </ul>
            </div>
            <TopicList query={`author=${encodeURIComponent(profile.username)}`} />
          </div>
        </div>
      </div>
    </div>
  );
}
