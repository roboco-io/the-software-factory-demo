import { HashRouter, Route, Routes } from "react-router";
import { AuthProvider } from "./auth/AuthContext";
import { Footer } from "./components/Footer";
import { Header } from "./components/Header";
import { ArticlePage } from "./pages/ArticlePage";
import { Auth } from "./pages/Auth";
import { BookPage } from "./pages/BookPage";
import { Editor } from "./pages/Editor";
import { Home } from "./pages/Home";
import { Profile } from "./pages/Profile";
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
          <Route path="/editor" element={<Editor />} />
          <Route path="/editor/:slug" element={<Editor />} />
          <Route path="/article/:slug" element={<ArticlePage />} />
          <Route path="/profile/:username" element={<Profile />} />
          <Route path="/book/:docId" element={<BookPage />} />
          <Route path="*" element={<Home />} />
        </Routes>
        <Footer />
      </HashRouter>
    </AuthProvider>
  );
}
