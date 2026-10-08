"""Use the user's requested DeepSeek V4.1 Flash for a reviewable video draft.

Secrets are read locally, never included in output or saved with artifacts.
This script sends the supplied chapter text and editorial constraints to DeepSeek.
"""
import argparse
import json
import os
from pathlib import Path
import re
import urllib.error
import urllib.request

SCENE_TYPES = ["intro", "toolkit", "choice", "case", "prior", "request", "interpret", "checklist", "contrast", "kidney", "quiz", "recap"]


def api_key(root):
    key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    for relative in [".env", ".env.local", "server/.env", "server/.env.local", "worker/.env"]:
        path = root / relative
        if not key and path.is_file():
            for line in path.read_text(encoding="utf-8-sig").splitlines():
                match = re.match(r"^\s*(?:export\s+)?DEEPSEEK_API_KEY\s*=\s*(.*?)\s*$", line)
                if match:
                    key = match.group(1).strip().strip("\"").strip("'")
                    break
    if not key:
        raise SystemExit("DEEPSEEK_API_KEY is not configured; no replacement model was used.")
    return key


def request_json(url, key, payload=None):
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=body, headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise SystemExit(f"DeepSeek returned HTTP {error.code}; no replacement model was used.") from None
    except urllib.error.URLError:
        raise SystemExit("DeepSeek could not be reached; no replacement model was used.") from None


def validate(data):
    scenes = data.get("scenes", [])
    if len(scenes) != len(SCENE_TYPES):
        raise SystemExit("Storyboard must have exactly 12 scenes; response saved separately for review.")
    for index, (scene, expected_type) in enumerate(zip(scenes, SCENE_TYPES), 1):
        if scene.get("type") != expected_type:
            raise SystemExit(f"Scene {index} must use type {expected_type}.")
        scene["id"] = f"scene-{index:02d}"
        for key in ["title", "subtitle", "narration"]:
            if not isinstance(scene.get(key), str) or not scene[key].strip():
                raise SystemExit(f"Scene {index} is missing {key}.")
        if len(scene["title"]) > 60 or len(scene["subtitle"]) > 100:
            raise SystemExit(f"Scene {index} has an overlong heading.")
        if not isinstance(scene.get("bullets"), list) or not 1 <= len(scene["bullets"]) <= 3:
            raise SystemExit(f"Scene {index} needs 1-3 short bullets.")
        if any(not isinstance(x, str) or len(x) > 72 for x in scene["bullets"]):
            raise SystemExit(f"Scene {index} has an overlong bullet.")
    return data


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", default="artifacts/videos/diagnostic-imaging")
    parser.add_argument("--refine", action="store_true")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    directory = (root / args.directory).resolve()
    source = (directory / "source-excerpt.txt").read_text(encoding="utf-8")
    key = api_key(root)
    models = request_json("https://api.deepseek.com/models", key)
    if not any(model.get("id") == "deepseek-flash" for model in models.get("data", [])):
        raise SystemExit("deepseek-flash is not listed by this account; no substitute model was used.")
    instructions = """You are drafting an original animated medical-school lesson from a supplied partial chapter.
Use friendly female character Athena as a recurring imaging detective with light humour aimed at confusing systems, never at patients, illness, injuries or emergencies.
Deliver ONLY a JSON object {title, subtitle, scenes}. Exactly 12 scenes with type in this exact order:
intro, toolkit, choice, case, prior, request, interpret, checklist, contrast, kidney, quiz, recap.
Each scene has id, type, title (<=45 characters), subtitle (<=75 characters), bullets (1-3 strings each <=58 characters), and narration (plain spoken English).
Target 600-750 total spoken words, 40-70 per scene, with a memorable analogy in intro/choice/prior and a concise student check at the end. Narration must be an original paraphrase, not copied chapter sentences. No visual or stage instructions inside narration. Use 'C T', 'M R I', and 'M D T' in narration for intelligible speech, but normal acronyms in headings. Spell out eGFR in narration if needed. No markdown.
Scenes must cover: why diagnosis matters; toolkit overview; question-first test selection; suspected biliary disease example with ultrasound; value of prior imaging; good request with provisional diagnosis, question, relevant history and pregnancy possibility; systematic interpretation with formal report; label/site/side/quality/compare/conclude; contrast precautions; individualized kidney risks; one retrieval question; recap.
Toolkit: x-rays and CT use ionizing radiation; ultrasound uses sound and Doppler evaluates blood flow; MRI uses strong magnetic fields and radio waves. Show these as a toolbox, not a rigid ranking. Do not imply MRI is universally safest or that a normal ultrasound excludes every condition.
The case must remain educational: for suspected biliary disease/right-upper-quadrant pain, ultrasound is commonly the initial examination; next imaging depends on findings and clinical context. Do not recommend surgery or specific treatment for an individual.
For requesting imaging: flag prior contrast reaction, kidney disease, relevant medicines, allergies and pregnancy possibility; discuss uncertainty with radiologist. Do not imply every listed disease prohibits contrast.
Current contrast editorial constraints verified against ACR Manual 2026 and ESUR 2025: for IV iodinated contrast, flag acute kidney injury and severely impaired kidney function; AKI or eGFR below 30 mL/min/1.73 square metres requires individualized benefit-risk assessment. Any preventive fluids are clinician-directed and need individualization for heart failure/fluid overload. Do not frame all kidney injury after contrast as caused by contrast. Say severe reactions can occur and teams must be prepared, without quoted frequencies.
Do not repeat the chapter's numeric reaction rates, ten-times-safer claim, blanket six-hour steroid rule, universal hydration advice, specific prophylactic drug recommendations, or 30-minute observation rule. Do not complete or teach the truncated metformin sentence. Omit metformin entirely.
For quiz scene add question, options [{label:'A',text:...},{label:'B',text:...},{label:'C',text:...}], answer ('A'/'B'/'C') and explanation. Ask what makes a useful imaging request; correct answer is clear clinical question plus relevant context. Narration asks viewer to pause, then reveals and explains. No fabricated diagnostic scan findings.
Recap ends with the spoken sentence 'This is an educational draft awaiting medical editorial review.' Do not describe yourself as a physician or give personal medical advice.
"""
    input_text = "Create the storyboard using this supplied excerpt:\n\n" + source
    if args.refine:
        previous = (directory / "storyboard.json").read_text(encoding="utf-8")
        (directory / "deepseek-storyboard-initial.json").write_text(previous, encoding="utf-8")
        instructions += "\nCRITICAL REVISION: Previous narration was too long. Rewrite to 35-60 words per scene, maximum 65 words in any scene and maximum 750 words total. Keep all 12 scenes and same field contract. For spoken kidney risk use 'acute kidney injury or an estimated filtration rate below thirty requires an individualized review' and on-screen bullet 'IV iodinated contrast: AKI / eGFR <30'. Do not give contrast dosing instructions; say the radiology team selects the appropriate protocol. Replace 'safe ultrasound' with 'no ionizing radiation'. Replace claims all history affects contrast choice with 'relevant history and medicines guide scan safety and preparation'. In prior-image bullet say 'May avoid unnecessary repeat scans', not unconditional reduces cost/radiation. Quiz bullets must not reveal correct answer before the question. Narration remains plain English and original."
        input_text += "\n\nRefine this previous draft using the revision instructions:\n" + previous
    payload = {"model": "deepseek-flash", "instructions": instructions, "input": input_text, "reasoning": {"effort": "none"}, "max_output_tokens": 6000, "temperature": 0.45, "text": {"format": {"type": "json_object"}}}
    result = request_json("https://api.deepseek.com/responses", key, payload)
    text_parts = [part.get("text", "") for item in result.get("output", []) if item.get("type") == "message" for part in item.get("content", []) if part.get("type") == "output_text"]
    content = "".join(text_parts).strip()
    if not content:
        raise SystemExit("DeepSeek returned no storyboard text; no replacement model was used.")
    (directory / "deepseek-storyboard-original.json").write_text(content + "\n", encoding="utf-8")
    try:
        data = validate(json.loads(content))
    except json.JSONDecodeError:
        raise SystemExit("DeepSeek returned invalid JSON; its response was saved for review.") from None
    data["status"] = "educational-draft-review-pending"
    data["source_scope"] = "Supplied partial chapter excerpt; truncated metformin section omitted"
    data["model"] = result.get("model", "deepseek-flash")
    (directory / "storyboard.json").write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    metadata = {"provider": "DeepSeek", "requested_model": "deepseek-flash", "documented_model_family": "DeepSeek V4.1 Flash", "returned_model": result.get("model"), "response_id": result.get("id"), "usage": result.get("usage"), "source_scope": data["source_scope"], "editorial_status": data["status"]}
    (directory / "generation-metadata.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    words = sum(len(scene["narration"].split()) for scene in data["scenes"])
    print(f"DeepSeek storyboard saved: {len(data['scenes'])} scenes, {words} spoken words; model {data['model']}.")


if __name__ == "__main__":
    main()
