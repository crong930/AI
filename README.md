# AI

클라우드(claude.ai/code)에서 Claude Code를 쓸 때 **Superpowers** 스킬을 쓰기 위한 작업 공간이에요.

클라우드 세션은 플러그인을 설치하지 못해서, Superpowers 플러그인의 스킬을 이 저장소의
`.claude/skills/` 안에 직접 넣어 두었어요. 세션이 시작되면 `.claude/settings.json`의
SessionStart 훅이 `using-superpowers` 안내를 Claude에게 넣어 줘요. 플러그인과 같은 방식이에요.

- 출처: https://github.com/obra/superpowers (v7.0.2), MIT 라이선스 (`.claude/skills/SUPERPOWERS-LICENSE`)
- 업데이트: 원본 저장소의 `skills/` 폴더를 다시 복사해 넣으면 돼요.

새 작업(웹사이트, 앱 등)은 이 저장소 안에 폴더를 만들어서 하면 돼요.
