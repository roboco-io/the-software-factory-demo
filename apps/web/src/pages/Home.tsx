import { BookToc } from "../components/BookToc";
import { TopicList } from "../components/TopicList";

export function Home() {
  return (
    <div className="home-page">
      <div className="banner">
        <div className="container">
          <h1 className="logo-font">conveyor</h1>
          <p>『The Software Factory』를 함께 읽고 토론하는 곳</p>
        </div>
      </div>
      <div className="container page">
        <div className="row">
          <div className="col-md-9">
            <h2>최근 토론</h2>
            <TopicList query="" />
          </div>
          <div className="col-md-3">
            <div className="sidebar">
              <h2>책 목차</h2>
              <BookToc />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
