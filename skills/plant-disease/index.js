const DISEASES = [
  {
    disease: "Powdery Mildew (白粉病)",
    keywords: ["powder", "powdery", "white coat", "white film", "mildew", "ash", "white spot on leaf", "白粉"],
    symptoms: "White powdery coating on leaves, stems and buds; leaves may curl and yellow.",
    treatment: "Apply sulfur or potassium bicarbonate sprays, remove infected leaves, improve air circulation.",
    prevention: "Avoid overhead watering, space plants, prune for airflow, choose resistant cultivars.",
  },
  {
    disease: "Late Blight (晚疫病)",
    keywords: ["brown circular", "circular spot", "halo", "dark lesion", "blight", "water soak", "brown spot with yellow", "晚疫"],
    symptoms: "Irregular brown-black lesions on leaves with yellow halos; white mold under leaves in wet weather.",
    treatment: "Remove and destroy infected foliage, apply copper-based fungicide, avoid wetting leaves.",
    prevention: "Use disease-free seed, rotate crops, ensure good drainage and airflow.",
  },
  {
    disease: "Early Blight (早疫病)",
    keywords: ["target", "concentric", "ring", "bullseye", "early blight", "brown spot", "ring spot", "早疫"],
    symptoms: "Concentric ring (target board) spots on lower leaves; yellowing and leaf drop.",
    treatment: "Mulch around base, apply chlorothalonil or copper sprays, remove lower infected leaves.",
    prevention: "Rotate solanaceous crops, water at soil level, keep foliage dry.",
  },
  {
    disease: "Rust (锈病)",
    keywords: ["rust", "orange", "powdery orange", "reddish", "pustule", "锈"],
    symptoms: "Orange to reddish-brown powdery pustules on leaf undersides; yellowing and leaf drop.",
    treatment: "Remove infected leaves, apply sulfur or myclobutanil, dispose of fallen debris.",
    prevention: "Water at the base, ensure good spacing, clean up plant debris in fall.",
  },
  {
    disease: "Leaf Spot / Anthracnose (叶斑病/炭疽病)",
    keywords: ["spot", "black spot", "brown spot", "tan spot", "lesion", "anthracnose", "叶斑", "炭疽"],
    symptoms: "Circular or angular brown/black/tan spots, sometimes with dark margins, on leaves and fruits.",
    treatment: "Prune affected parts, apply copper fungicide, avoid overhead irrigation.",
    prevention: "Remove debris, rotate crops, use drip irrigation.",
  },
  {
    disease: "Root Rot (根腐病)",
    keywords: ["rot", "wilting", "wilt despite water", "mushy", "soggy", "soft stem", "root rot", "根腐"],
    symptoms: "Yellowing, wilting despite moist soil, soft/rotting roots and lower stem base.",
    treatment: "Improve drainage, repot with fresh soil, trim rotted roots, reduce watering.",
    prevention: "Use well-draining potting mix, avoid overwatering, ensure pots have drainage holes.",
  },
  {
    disease: "Botrytis / Gray Mold (灰霉病)",
    keywords: ["gray mold", "grey mold", "gray fuzz", "grey fuzz", "botrytis", "soft brown", "灰霉"],
    symptoms: "Soft brown rot with fuzzy gray mold on flowers, fruits and leaves.",
    treatment: "Remove infected tissue, improve ventilation, apply fungicide labeled for botrytis.",
    prevention: "Avoid crowding, water in the morning, remove spent flowers promptly.",
  },
];

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ");
}

export default async function run(input) {
  const q = normalize(input);
  if (!q) return "No symptoms provided.";
  const hits = DISEASES.map((d) => {
    const matched = d.keywords.filter((k) => q.includes(normalize(k)));
    return matched.length ? { ...d, matched } : null;
  })
    .filter(Boolean)
    .sort((a, b) => b.matched.length - a.matched.length)
    .slice(0, 3);

  if (!hits.length) {
    return JSON.stringify(
      {
        diagnosis: [],
        note: `No known disease matched "${String(input).trim()}". For serious or unclear cases, please consult a local agricultural extension service.`,
      },
      null,
      2,
    );
  }
  return JSON.stringify(
    {
      diagnosis: hits.map((h) => ({
        disease: h.disease,
        matched: h.matched,
        symptoms: h.symptoms,
        treatment: h.treatment,
        prevention: h.prevention,
      })),
    },
    null,
    2,
  );
}
