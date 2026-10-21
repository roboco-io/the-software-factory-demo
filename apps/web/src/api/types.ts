export type User = {
  email: string;
  token: string;
  username: string;
  bio: string | null;
  image: string | null;
};
export type Profile = {
  username: string;
  bio: string | null;
  image: string | null;
  following: boolean;
};
export type Errors = Record<string, string[]>;
export type BookDocument = {
  docId: string;
  kind: "preface" | "chapter" | "pattern" | "demo";
  title: string;
  revision: number;
  topicCount: number;
};
export type BookSection = { anchor: string; heading: string; topicCount: number };
export type TopicKind = "question" | "argument" | "case" | "general";
export type Topic = {
  id: number;
  title: string;
  body: string;
  kind: TopicKind;
  author: Author;
  book: {
    docId: string;
    anchor: string | null;
    revision: number;
    status: "current" | "revised" | "removed";
  } | null;
  replyCount: number;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
};
export type Reply = {
  id: number;
  topicId: number;
  parentId: number | null;
  body: string;
  author: Author;
  score: number;
  voted: boolean;
  deleted: boolean;
  createdAt: string;
  updatedAt: string;
};
export type Author = {
  username: string;
  image: string | null;
  kind?: "human" | "agent";
  owner?: string | null;
};
