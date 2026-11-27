# 내 주식 히트맵 (토스증권 실시간 연동)

토스증권 Open API로 내 계좌의 보유 종목, 주문가능 현금, 주가 흐름을 5초마다 불러와
섹터별 히트맵으로 보여주는 프로그램이에요. **조회만 하고 주문 기능은 없어요.**
키는 내 컴퓨터의 `config.json`에만 저장되고, 화면은 내 컴퓨터(localhost)에서만 열려요.

## 처음 한 번 준비

1. **Node.js 설치**: https://nodejs.org 에서 LTS 버전을 받아 설치해요.
2. **토스증권 Open API 설정** (PC 웹 토스증권 → 설정 → Open API)
   - Client Id와 Client Secret을 확인해요. Secret은 발급할 때 한 번만 보여줄 수 있으니 안전한 곳에 적어 두세요.
   - **허용 IP 관리**에 지금 쓰는 컴퓨터의 공인 IP를 등록해요. 네이버에서 "내 IP"를 검색하면 나와요.
     공유기를 다시 켜거나 다른 와이파이에 붙으면 IP가 바뀔 수 있어요. 그때 다시 등록해 주세요.
3. **config.json 만들기**: 이 폴더의 `config.example.json`을 복사해 `config.json`으로 이름을 바꾸고,
   `clientId`, `clientSecret` 자리에 값을 붙여넣어 저장해요. (실행 파일을 먼저 한 번 돌리면 자동으로 복사돼요.)

## 실행

- Windows: `start-windows.bat` 더블클릭
- Mac: `start-mac.command` 더블클릭 (처음엔 우클릭 → 열기)

잠시 뒤 브라우저에 http://localhost:8787 이 열려요. 끌 때는 검은 창에서 Ctrl+C 를 누르거나 창을 닫으면 돼요.
키 없이 실행하면 예시 데이터로 도는 **데모 모드**로 열려요.

## 화면

- 위쪽: 총 자산(주식+현금), 주식 평가금액, 평가손익, 오늘 손익, 주문가능 현금(원/달러)
- 히트맵: 섹터별로 묶고, 크기는 평가금액, 색은 수익률. "총 수익률 / 오늘 등락" 전환 가능
- 종목을 누르면 아래에 일봉(약 6개월) 또는 분봉(최근 200분) 차트와 내 평균단가 선이 나와요
- 맨 아래 보유 종목 표는 머리글을 눌러 정렬할 수 있어요
- 종목을 누르면 **빠른 분석**과 **딥 리서치** 두 버튼도 나와요. 아래 "AI 분석 켜기"를 먼저 해 주세요

## AI 분석 켜기

종목을 눌러 AI(Claude, ChatGPT, Gemini)에게 분석 보고서를 받을 수 있어요. 키가 없으면 예시 보고서가 나오는 데모로 동작해요.

1. **API 키 받기** (쓰고 싶은 AI만 받아도 돼요. 결제 수단을 등록해야 해요)
   - Claude: https://console.anthropic.com
   - ChatGPT(OpenAI): https://platform.openai.com
   - Gemini: https://aistudio.google.com — 꼭 **결제가 켜진(유료) 키**를 쓰세요. 무료 키는 입력한 내용이 AI 학습에 쓰일 수 있어요.
   - **각 사이트(Anthropic, OpenAI, Google)의 결제 설정에서 월 사용 한도(spend limit)를 꼭 걸어 두세요.** 프로그램에도 한도가 있지만, 사이트 한도가 마지막 안전장치예요.
2. 이 폴더의 `config.json`을 **메모장**으로 열어요. (우클릭 → 연결 프로그램 → 메모장)
3. `anthropicApiKey`, `openaiApiKey`, `geminiApiKey`의 **따옴표 사이**에 받은 키를 붙여넣어요. 안 쓰는 AI는 그대로 두면 돼요.
   - 예전에 만든 `config.json`에 이 세 줄이 없다면, `"clientSecret": "..."` 줄 끝에 **쉼표(,)가 있는지 확인**하고 그 바로 아래에 다음 세 줄을 그대로 복사해 넣어요.
     ```
       "anthropicApiKey": "여기에 Claude API 키 붙여넣기",
       "openaiApiKey": "여기에 ChatGPT(OpenAI) API 키 붙여넣기",
       "geminiApiKey": "여기에 Gemini API 키 붙여넣기",
     ```
     넣은 뒤 모습은 이래요 (마지막 항목 뒤에는 쉼표가 없어야 해요):
     ```
       "clientSecret": "내 Client Secret",
       "anthropicApiKey": "sk-ant-...",
       "openaiApiKey": "sk-...",
       "geminiApiKey": "AIza...",
       "refreshSeconds": 5
     ```
   - 실행했을 때 검은 창에 **"config.json 형식이 잘못됐어요"**가 나오면 쉼표(,)나 따옴표(")가 빠졌을 가능성이 커요. 줄 끝 쉼표와 따옴표 짝을 확인해 주세요.
4. 저장(Ctrl+S)하고, 검은 창을 닫은 뒤 `start-windows.bat`을 다시 실행해요.

**AI에게 보내는 정보**: 종목 이름/심볼, 시장, 현재가, 오늘 등락률, 내 평균 매수가, 수익률, 포트폴리오 내 비중(%)

**보내지 않는 정보**: 보유 수량, 금액(평가금액·손익), 현금, 계좌 정보, API 키

**두 가지 분석**
- **빠른 분석**: 약 1~2분, 수백 원 정도예요.
- **딥 리서치**: 약 5~20분, 보통 1만~2만 5천 원이에요. 한도를 걸어 두었지만 드물게 더 나올 수 있어요. 시작 전에 비용 확인 창이 뜨고, 도중에 취소 버튼으로 멈출 수 있어요. 프로그램을 껐다 켜면 ChatGPT·Gemini 딥 리서치는 이어받고, Claude 부분은 처음부터 다시 실행돼요.

**한도 바꾸기** (`config.json`)
- `deepResearchLimit`: `enabled`(비용 한도 사용 여부, 기본 true — 끄면 한도 없이 돌아서 비용이 더 나올 수 있어요), `claudeMaxSearches`(기본 30), `openaiMaxToolCalls`(기본 40), `timeoutMinutes`(기본 30). 예: `"deepResearchLimit": { "enabled": true, "claudeMaxSearches": 20 }`
- `models`: 쓰는 모델 이름. `claudeQuick`, `claudeDeep`, `openaiQuick`, `openaiDeep`, `geminiQuick`, `geminiDeep`. 예: `"models": { "openaiQuick": "gpt-5" }`

**보고서 저장 위치**: 이 폴더의 `reports/` 안에 보고서마다 `.json`과 `.md` 파일이 생겨요. 화면의 **지난 보고서**에서 다시 열 수 있어요.

**키는 채팅이나 다른 사람에게 절대 보내지 마세요.** 유출됐다면 해당 사이트에서 키를 지우고 새로 만드세요.

## 설정 (config.json)

| 항목 | 뜻 |
|---|---|
| `refreshSeconds` | 몇 초마다 새로 불러올지 (기본 5, 최소 2) |
| `port` | 화면 주소의 포트 (기본 8787) |
| `accountSeq` | 계좌가 여러 개일 때 쓸 계좌 번호(accountSeq). 비우면 종합매매 계좌 |
| `sectorOverrides` | 섹터를 직접 지정. 예: `{"005930": "반도체", "TSLA": "전기차"}` |

섹터는 토스증권 섹터 분류(대분류)를 하루 한 번 불러와 `.sector-cache.json`에 저장해 써요. 처음 켤 때 1~2분 걸릴 수 있어요.

## 문제가 생기면

- **403 / 허용 IP**: 토스증권 Open API의 허용 IP에 지금 컴퓨터의 공인 IP가 등록돼 있는지 확인해요.
- **토큰 발급 실패**: Client Id/Secret 오타, 앞뒤 공백을 확인해요.
- **AI 분석 오류**: 키 오타, 결제 수단 미등록, 모델 이름 변경이 흔한 원인이에요. 모델 이름은 `config.json`의 `models`로 바꿀 수 있어요.
- **포트 사용 중**: 이미 켜져 있거나, config.json의 `port`를 다른 숫자로 바꿔요.

`config.json`에는 비밀키가 들어 있어요. 다른 사람에게 보내거나 인터넷에 올리지 마세요.

## 검은 창 없이 쓰기 (Windows)

1. 이 폴더의 `make-shortcuts.vbs`를 한 번 더블클릭해요. 바탕화면에 바로가기 두 개가 생겨요.
2. **내 주식 포트폴리오 켜기**: 검은 창 없이 켜고 브라우저를 열어요. 이미 켜져 있으면 브라우저만 열어요.
3. **내 주식 포트폴리오 끄기**: 숨겨서 켠 프로그램을 꺼요.

화면에 오류가 보이면 같은 폴더의 `server.log`를 열어 보거나, `start-windows.bat`으로 켜서 검은 창의 글을 확인해요.

## AI 잔액 보기 (예상)

히트맵 오른쪽 위 **💰 AI 잔액**을 누르면 AI별 예상 잔액이 나와요.
회사들이 일반 API 키로 잔액을 알려주지 않아서, 각 회사 사이트에서 본 **지금 잔액(달러)** 을 한 번 넣으면 이 프로그램이 쓴 만큼 빼서 보여줘요.
단가로 계산한 추정치예요. 단가와 환율은 `config.json`에 `"prices"`, `"usdKrw": 1400` 으로 바꿀 수 있어요. 기록은 `reports/.usage.json`에 남아요.

## 환차익·환차손 (미국 주식)

토스 보유 조회에는 "산 때 환율"이 없어서, 토스 **거래내역**의 매수 기록에 적힌 환율로 종목별 평균 매입 환율을 구해요(이동평균법, 30분마다 새로 불러와요).
환차손익 = 매입금액($) × (지금 환율 − 산 때 평균 환율). 평가손익은 지금처럼 주가 변화만 보여줘요.
다른 증권사에서 옮겨온 주식처럼 매수 기록이 없는 종목은 "—"로 보여요.
