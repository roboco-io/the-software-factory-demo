네트워크 점검 결과 문서 추가

docs/NETWORK.md를 만들고, 샌드박스에서 아래 세 명령을 실제로 실행한 결과(HTTP 상태 코드와 응답의 첫 줄)를 표로 기록한다. 명령이 실패하면 실패한 그대로 기록한다.

    curl -s -m 20 -o /dev/null -w "%{http_code}" https://example.com/
    curl -s -m 20 https://example.com/ | head -1
    curl -s -m 20 -o /dev/null -w "%{http_code}" https://api.github.com/zen
