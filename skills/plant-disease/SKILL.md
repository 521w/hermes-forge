---
name: plant-disease
description: Diagnose common plant diseases from symptom descriptions and return prevention/treatment advice. Use for questions about wilting, spots, mildew, rot, yellowing leaves, etc.
---

# Plant Disease Skill

Maps symptom keywords from the user's description to likely plant diseases and returns practical prevention and treatment guidance.

## Usage

Hand the skill the symptom description as `input`. Example:

- `input: "tomato leaves have brown circular spots with yellow halos"`
- `input: "my rose has white powdery coating on leaves"`

## Output

A JSON list of candidate diagnoses: `[{ disease, match, symptoms, treatment, prevention }]`. If no known disease matches, returns suggestions and advice to consult a local extension service.

## Notes

- Diagnosis is keyword-based and best-effort; always recommend confirming with a local agronomist for serious cases.
- Include plant type in the query when possible — it improves matching.
