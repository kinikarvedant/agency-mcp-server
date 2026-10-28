import { getHtml, jsonLd, type Ctx } from "../context.js";

type Node = Record<string, unknown>;
interface Result { errors: string[]; warnings: string[] }

const isObj = (v: unknown): v is Node => typeof v === "object" && v !== null && !Array.isArray(v);
const has = (n: Node, k: string) => n[k] !== undefined && n[k] !== null && n[k] !== "" && !(Array.isArray(n[k]) && !n[k].length);
const list = (v: unknown) => [v].flat().filter((x) => x !== undefined && x !== null);
const typesOf = (n: Node) => list(n["@type"]).filter((t): t is string => typeof t === "string").map((t) => t.replace(/^https?:\/\/schema\.org\//, ""));
const absUrl = (v: unknown) => typeof v === "string" && /^https?:\/\/[^/]/.test(v);
const isoDate = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) && !Number.isNaN(Date.parse(v));

function need(n: Node, r: Result, k: string) { if (!has(n, k)) r.errors.push(`Missing ${k}.`); }
function want(n: Node, r: Result, k: string) { if (!has(n, k)) r.warnings.push(`Missing ${k} (recommended).`); }

// Common LocalBusiness subtypes from schema.org; any of them is checked as a LocalBusiness.
const LOCAL_BUSINESS = new Set(("LocalBusiness Dentist Plumber Electrician Locksmith HVACBusiness RoofingContractor GeneralContractor " +
  "HousePainter MovingCompany HomeAndConstructionBusiness CafeOrCoffeeShop Restaurant Bakery BarOrPub FoodEstablishment Store " +
  "MedicalBusiness MedicalClinic Physician Optician Pharmacy VeterinaryCare HealthAndBeautyBusiness HairSalon BeautySalon DaySpa " +
  "ExerciseGym ProfessionalService LegalService Attorney AccountingService RealEstateAgent AutoRepair AutomotiveBusiness ChildCare " +
  "LodgingBusiness Hotel").split(" "));
const ARTICLE = new Set(["Article", "NewsArticle", "BlogPosting", "TechArticle", "Report", "ScholarlyArticle"]);

const RULES: Record<string, (n: Node, r: Result) => void> = {
  LocalBusiness(n, r) {
    need(n, r, "name");
    need(n, r, "address");
    if (typeof n.address === "string") r.warnings.push("address is plain text; a PostalAddress lets parsers read street, suburb and postcode.");
    else if (isObj(n.address))
      for (const k of ["streetAddress", "addressLocality", "postalCode", "addressCountry"]) if (!has(n.address, k)) r.warnings.push(`Missing address.${k}.`);
    for (const k of ["telephone", "url", "image", "geo", "priceRange"]) want(n, r, k);
    if (!has(n, "openingHoursSpecification") && !has(n, "openingHours")) r.warnings.push("Missing openingHoursSpecification (recommended).");
    if (isObj(n.geo)) {
      const lat = Number(n.geo.latitude), lng = Number(n.geo.longitude);
      if (!(Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) r.errors.push("geo latitude/longitude are not valid coordinates.");
    }
    if (has(n, "url") && !absUrl(n.url)) r.errors.push("url is not an absolute http(s) URL.");
  },
  Service(n, r) {
    if (!has(n, "name") && !has(n, "serviceType")) r.errors.push("Missing name or serviceType.");
    for (const k of ["provider", "areaServed", "description"]) want(n, r, k);
  },
  FAQPage(n, r) {
    const qs = list(n.mainEntity);
    if (!qs.length) r.errors.push("mainEntity has no Question items.");
    qs.forEach((q, i) => {
      if (!isObj(q) || !typesOf(q).includes("Question")) return void r.errors.push(`mainEntity[${i}] is not a Question.`);
      if (!has(q, "name")) r.errors.push(`Question ${i + 1} has no name (the question text).`);
      const a = list(q.acceptedAnswer)[0];
      if (!isObj(a)) r.errors.push(`Question ${i + 1} has no acceptedAnswer.`);
      else if (!has(a, "text")) r.errors.push(`Question ${i + 1}'s acceptedAnswer has no text.`);
    });
  },
  Article(n, r) {
    need(n, r, "headline");
    for (const k of ["author", "datePublished", "dateModified", "image"]) want(n, r, k);
    for (const k of ["datePublished", "dateModified"]) if (has(n, k) && !isoDate(n[k])) r.errors.push(`${k} is not an ISO 8601 date.`);
    for (const a of list(n.author)) if (!isObj(a) || !has(a, "name")) r.warnings.push("author should be a Person or Organization with a name.");
  },
  BreadcrumbList(n, r) {
    const items = list(n.itemListElement);
    if (!items.length) r.errors.push("itemListElement is empty.");
    items.forEach((it, i) => {
      if (!isObj(it) || !typesOf(it).includes("ListItem")) return void r.errors.push(`itemListElement[${i}] is not a ListItem.`);
      const pos = Number(it.position);
      if (!Number.isInteger(pos)) r.errors.push(`Crumb ${i + 1} has no integer position.`);
      else if (pos !== i + 1) r.warnings.push(`Crumb ${i + 1} has position ${pos}; positions should run 1, 2, 3 in order.`);
      const item = isObj(it.item) ? (it.item["@id"] ?? it.item.url) : it.item;
      if (!has(it, "name") && !(isObj(it.item) && has(it.item, "name"))) r.errors.push(`Crumb ${i + 1} has no name.`);
      if (!item && i < items.length - 1) r.errors.push(`Crumb ${i + 1} has no item URL (only the last crumb may leave it out).`);
      else if (item && !absUrl(item)) r.warnings.push(`Crumb ${i + 1}'s item is not an absolute URL.`);
    });
  },
};

function ruleFor(types: string[]): string | undefined {
  for (const t of types) {
    if (RULES[t]) return t;
    if (LOCAL_BUSINESS.has(t)) return "LocalBusiness";
    if (ARTICLE.has(t)) return "Article";
  }
}

const schemaContext = (c: unknown): boolean =>
  typeof c === "string" ? /^https?:\/\/schema\.org\/?$/.test(c) : Array.isArray(c) ? c.some(schemaContext) : isObj(c) && schemaContext(c["@vocab"]);

/** A node holding only an id, a type and a name points at an entity described elsewhere. */
const isReference = (n: Node) => Object.keys(n).every((k) => ["@id", "@type", "name", "url"].includes(k)) && has(n, "@id");

/** Checks JSON-LD against the properties Google's rich-result docs and schema.org expect for five common types. */
export function validateJsonLd(blocks: { data?: unknown; error?: string }[]) {
  const parseErrors: string[] = [];
  const items: { type: string; checkedAs: string; at: string; errors: string[]; warnings: string[] }[] = [];
  const unchecked = new Set<string>();

  blocks.forEach((b, bi) => {
    if (b.error !== undefined) return void parseErrors.push(`Block ${bi + 1} is not valid JSON: ${b.error}`);
    const roots = list(b.data);
    const walk = (v: unknown, at: string, top: boolean) => {
      if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${at}[${i}]`, top));
      if (!isObj(v)) return;
      const types = typesOf(v);
      if (types.length && !isReference(v)) {
        const rule = ruleFor(types);
        if (rule) {
          const r: Result = { errors: [], warnings: [] };
          if (top && !schemaContext(v["@context"]) && !schemaContext((b.data as Node)?.["@context"]))
            r.errors.push('No "@context": "https://schema.org".');
          RULES[rule](v, r);
          items.push({ type: types.join(", "), checkedAs: rule, at, ...r });
        } else if (top) types.forEach((t) => unchecked.add(t));
      }
      for (const [k, x] of Object.entries(v)) if (k !== "@context") walk(x, `${at}.${k}`, k === "@graph");
    };
    roots.forEach((root, i) => walk(root, `block ${bi + 1}${roots.length > 1 ? `[${i}]` : ""}`, true));
  });

  return {
    blocks: blocks.length,
    parseErrors,
    items,
    uncheckedTypes: [...unchecked],
    summary: {
      items: items.length,
      errors: parseErrors.length + items.reduce((s, i) => s + i.errors.length, 0),
      warnings: items.reduce((s, i) => s + i.warnings.length, 0),
    },
    checks: "Required and recommended properties for LocalBusiness (and subtypes), Service, FAQPage, Article and BreadcrumbList, plus value shapes (dates, URLs, coordinates, crumb positions). Not a full schema.org vocabulary check.",
  };
}

export async function validateStructuredData(ctx: Ctx, url: string) {
  const { page, doc } = await getHtml(ctx, url);
  return { url: page.url, ...validateJsonLd(jsonLd(doc)) };
}
