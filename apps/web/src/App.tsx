import { HashRouter, Route, Routes } from "react-router";
import { AuthProvider } from "./auth/AuthContext";
import { Footer } from "./components/Footer";
import { Header } from "./components/Header";
import { Auth } from "./pages/Auth";
import { BookPage } from "./pages/BookPage";
import { Home } from "./pages/Home";
import { Profile } from "./pages/Profile";
import { TopicEditor } from "./pages/TopicEditor";
import { TopicPage } from "./pages/TopicPage";
import { Settings } from "./pages/Settings";

export function App() {
  return (
    <AuthProvider>
      <HashRouter>
        <Header />
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/login" element={<Auth mode="login" />} />
          <Route path="/register" element={<Auth mode="register" />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/profile/:username" element={<Profile />} />
          <Route path="/book/:docId" element={<BookPage />} />
          <Route path="/new" element={<TopicEditor />} />
          <Route path="/topic/:id" element={<TopicPage />} />
          <Route path="/topic/:id/edit" element={<TopicEditor />} />
          <Route path="*" element={<Home />} />
        </Routes>
        <Footer />
      </HashRouter>
    </AuthProvider>
  );
}
