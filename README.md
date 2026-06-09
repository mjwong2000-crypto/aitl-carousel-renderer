[AI_Tool_Logbook_Hero_First_Setup_README.txt](https://github.com/user-attachments/files/28764944/AI_Tool_Logbook_Hero_First_Setup_README.txt)
AI TOOL LOGBOOK HERO-FIRST CAROUSEL SYSTEM

Airtable base:
YouTube Empire OS - Automation
Base ID:
app47YuxOKMw8vkCj

Existing table:
AI Tool Radar

Add these fields to AI Tool Radar:
- AITL Hero Key
- AITL Hero Slide URL
- AITL Hero Slide Approved
- AITL Hero Slide Notes
- AITL Carousel Status
- AITL Carousel Notes
- AITL FFmpeg Render URL
- Render URL
- Render Job ID
- Renderer ID
- Render Error

New table:
AITL Hero Assets

Fields:
- Hero Key
- Tool Name
- Theme
- Hero Image URL
- Status
- Notes

Status value:
Approved

Hero Keys:
- claude-ai-video-prompts
- claude-ai-side-income-prompts
- chatgpt-content-prompts
- chatgpt-canva-carousel-prompts
- gemini-notebooklm-study-prompts
- elevenlabs-voice-prompts

Final production rule:
Slide 1 = approved hero image from AITL Hero Assets.
Slides 2-5 = renderer-built prompt pack slides.
If no approved hero image exists, renderer blocks the post.
