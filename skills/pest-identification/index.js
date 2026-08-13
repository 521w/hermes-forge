const PESTS = [
  {
    pest: "Aphids (蚜虫)",
    keywords: ["aphid", "small green", "green insect", "black insect", "cluster", "honeydew", "sticky", "蚜虫"],
    signs: "Tiny pear-shaped insects (green/black/yellow) clustered on new growth and leaf undersides; sticky honeydew, ants present, distorted leaves.",
    damage: "Sap feeding stunts growth and distorts shoots; vectors plant viruses.",
    control: "Blast with water, introduce ladybugs/parasitoids, use insecticidal soap or neem oil.",
  },
  {
    pest: "Whiteflies (白粉虱)",
    keywords: ["white fly", "whiteflies", "whitefly", "tiny white", "fly up", "flutter", "白粉虱"],
    signs: "Very small white winged insects that fly up in a cloud when the plant is disturbed; yellow sticky traps get covered.",
    damage: "Sap feeding, honeydew and sooty mold; weakens plants.",
    control: "Yellow sticky traps, vacuum adults, use neem oil or insecticidal soap, introduce Encarsia wasps.",
  },
  {
    pest: "Spider Mites (红蜘蛛)",
    keywords: ["spider mite", "red mite", "tiny spider", "webbing", "web on leaf", "stippl", "speckl", "红蜘蛛", "螨"],
    signs: "Fine webbing on leaf undersides, yellow/white stippling dots on leaves, tiny moving specks.",
    damage: "Suck cell contents causing bronzing and leaf drop; thrives in dry heat.",
    control: "Increase humidity, spray with water, apply miticide or neem oil, release predatory mites.",
  },
  {
    pest: "Caterpillars / Armyworms (毛虫/夜蛾)",
    keywords: ["caterpillar", "worm", "chewed hole", "chewing", "frass", "leaf skeleton", "毛虫", "青虫"],
    signs: "Chewed or skeletonized leaves, rolled leaves, caterpillar present, dark frass pellets.",
    damage: "Defoliation; young fruit may be bored into.",
    control: "Hand-pick, use BT (Bacillus thuringiensis), row covers, encourage birds and parasitoid wasps.",
  },
  {
    pest: "Mealybugs (粉蚧)",
    keywords: ["mealybug", "white cotton", "cottony", "fluffy white", "wax", "粉蚧", "绵蚧"],
    signs: "White cottony clusters in leaf axils and under leaves; honeydew and sooty mold.",
    damage: "Sap feeding weakens plant; secretes honeydew attracting ants.",
    control: "Dab with alcohol swabs, wash off, apply neem oil, release Cryptolaemus beetles.",
  },
  {
    pest: "Thrips (蓟马)",
    keywords: ["thrips", "tiny elongated", "silvery streak", "streak", "scar", "蓟马"],
    signs: "Very small slender insects; silver-white streaking/scarring on leaves, black specks of frass.",
    damage: "Scarring and distortion of leaves and flowers; vector tomato spotted wilt virus.",
    control: "Blue sticky traps, remove weeds, use spinosad or neem oil, encourage predatory mites.",
  },
  {
    pest: "Scale Insects (介壳虫)",
    keywords: ["scale", "brown bump", "shell", "armored", "lump on stem", "介壳虫", "蚧壳虫"],
    signs: "Immobile brown/tan shell-like bumps on stems and leaf veins; honeydew and sooty mold.",
    damage: "Sap feeding weakens plants; heavy infestations cause yellowing and dieback.",
    control: "Scrape off, horticultural oil in dormant season, introduce parasitic wasps.",
  },
  {
    pest: "Slugs & Snails (蛞蝓/蜗牛)",
    keywords: ["slug", "snail", "silver trail", "slime trail", "mucous", "蛞蝓", "蜗牛", "鼻涕虫"],
    signs: "Irregular holes in leaves with silvery slime trails; active at night in damp weather.",
    damage: "Feeding damage to leaves, stems and fruits near ground level.",
    control: "Hand-pick at dusk, copper barriers, beer traps, diatomaceous earth, encourage ground beetles.",
  },
];

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ");
}

export default async function run(input) {
  const q = normalize(input);
  if (!q) return "No pest description provided.";
  const hits = PESTS.map((p) => {
    const matched = p.keywords.filter((k) => q.includes(normalize(k)));
    return matched.length ? { ...p, matched } : null;
  })
    .filter(Boolean)
    .sort((a, b) => b.matched.length - a.matched.length)
    .slice(0, 3);

  if (!hits.length) {
    return JSON.stringify(
      {
        pests: [],
        note: `No known pest matched "${String(input).trim()}". Capture a close-up photo and consult an entomologist or local extension service for confirmation.`,
      },
      null,
      2,
    );
  }
  return JSON.stringify(
    {
      pests: hits.map((h) => ({
        pest: h.pest,
        matched: h.matched,
        signs: h.signs,
        damage: h.damage,
        control: h.control,
      })),
    },
    null,
    2,
  );
}
