import { XMLParser } from 'fast-xml-parser';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const PUBMED_SEARCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi';
const PUBMED_FETCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi';

const BPD_BASE = '("Borderline Personality Disorder"[Mesh] OR borderline personality disorder[tiab] OR BPD[tiab] OR emotionally unstable personality disorder[tiab])';

const SEARCH_QUERIES = [
  BPD_BASE,
  `${BPD_BASE} AND (dialectical behavior therapy[tiab] OR DBT[tiab] OR mentalization-based treatment[tiab] OR MBT[tiab] OR schema therapy[tiab] OR transference-focused psychotherapy[tiab] OR TFP[tiab] OR general psychiatric management[tiab] OR GPM[tiab])`,
  `${BPD_BASE} AND (amygdala[tiab] OR prefrontal cortex[tiab] OR frontolimbic[tiab] OR fMRI[tiab] OR functional connectivity[tiab] OR cortisol[tiab] OR heart rate variability[tiab] OR neuroimaging[tiab])`,
  `${BPD_BASE} AND (childhood trauma[tiab] OR childhood maltreatment[tiab] OR adverse childhood experiences[tiab] OR complex PTSD[tiab] OR dissociation[tiab] OR depersonalization[tiab])`,
  `${BPD_BASE} AND (self-harm[tiab] OR nonsuicidal self-injury[tiab] OR NSSI[tiab] OR suicidal ideation[tiab] OR suicide attempt[tiab] OR suicid*[tiab])`,
  `${BPD_BASE} AND (psychotherapy[tiab] OR therapeutic alliance[tiab] OR emotion dysregulation[tiab] OR emotion regulation[tiab] OR mentalization[tiab] OR attachment[tiab])`,
  `${BPD_BASE} AND (stigma[tiab] OR service utilization[tiab] OR emergency department[tiab] OR social determinants[tiab] OR lived experience[tiab] OR recovery[tiab])`,
  `${BPD_BASE} AND (adolescent*[tiab] OR youth[tiab] OR early intervention[tiab] OR child*[tiab])`,
  `${BPD_BASE} AND (pharmacotherapy[tiab] OR medication[tiab] OR antipsychotic*[tiab] OR antidepressant*[tiab] OR mood stabilizer*[tiab])`,
  `${BPD_BASE} AND (inflammation[tiab] OR cytokine*[tiab] OR immune[tiab] OR oxytocin[tiab] OR HPA axis[tiab] OR autonomic[tiab])`,
];

const HEADERS = { 'User-Agent': 'BPDResearchBot/1.0 (research aggregator)' };

function buildDateFilter(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  const dateStr = d.toISOString().split('T')[0].replace(/-/g, '/');
  return `"${dateStr}"[Date - Publication] : "3000"[Date - Publication]`;
}

function getTaipeiDate() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().split('T')[0];
}

async function pubmedSearch(query, retmax = 20) {
  const url = `${PUBMED_SEARCH}?db=pubmed&term=${encodeURIComponent(query)}&retmax=${retmax}&sort=date&retmode=json`;
  try {
    const resp = await fetch(url, {
      headers: HEADERS,
      signal: AbortSignal.timeout(30000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    return data?.esearchresult?.idlist || [];
  } catch (err) {
    console.error(`[WARN] PubMed search failed: ${err.message}`);
    return [];
  }
}

async function pubmedFetch(pmids) {
  if (!pmids.length) return [];
  const ids = pmids.join(',');
  const url = `${PUBMED_FETCH}?db=pubmed&id=${ids}&retmode=xml`;
  try {
    const resp = await fetch(url, {
      headers: HEADERS,
      signal: AbortSignal.timeout(60000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const xml = await resp.text();
    return parseXmlPapers(xml);
  } catch (err) {
    console.error(`[WARN] PubMed fetch failed: ${err.message}`);
    return [];
  }
}

function parseXmlPapers(xml) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    isArray: (name) => ['PubmedArticle', 'AbstractText', 'Keyword'].includes(name),
  });
  let parsed;
  try {
    parsed = parser.parse(xml);
  } catch (err) {
    console.error(`[WARN] XML parse failed: ${err.message}`);
    return [];
  }

  const articles = parsed?.PubmedArticleSet?.PubmedArticle || [];
  if (!Array.isArray(articles)) return articles ? [extractPaper(articles)].filter(Boolean) : [];
  return articles.map(extractPaper).filter(p => p && p.title);
}

function extractPaper(article) {
  try {
    const medline = article.MedlineCitation || {};
    const art = medline.Article || {};

    const titleEl = art.ArticleTitle;
    const title = typeof titleEl === 'string' ? titleEl : (titleEl?.['#text'] || titleEl?.[''] || '');

    const abstractParts = [];
    const abstracts = art.Abstract?.AbstractText;
    if (abstracts) {
      const absList = Array.isArray(abstracts) ? abstracts : [abstracts];
      for (const abs of absList) {
        const label = abs?.['@_Label'] || '';
        const text = typeof abs === 'string' ? abs : (abs?.['#text'] || '');
        if (label && text) abstractParts.push(`${label}: ${text}`);
        else if (text) abstractParts.push(text);
      }
    }
    const abstract = abstractParts.join(' ').slice(0, 2000);

    const journal = art.Journal?.Title || '';
    const pubDate = art.Journal?.JournalIssue?.PubDate || {};
    const dateParts = [pubDate.Year, pubDate.Month, pubDate.Day].filter(Boolean);
    const dateStr = dateParts.join(' ');

    const pmidRaw = medline.PMID;
    const pmid = typeof pmidRaw === 'string' ? pmidRaw : (pmidRaw?.['#text'] || '');

    const keywords = [];
    const kwList = medline.KeywordList?.Keyword;
    if (kwList) {
      for (const kw of Array.isArray(kwList) ? kwList : [kwList]) {
        const kwText = typeof kw === 'string' ? kw : (kw?.['#text'] || '');
        if (kwText) keywords.push(kwText.trim());
      }
    }

    return {
      pmid: String(pmid),
      title: title.trim(),
      journal,
      date: dateStr,
      abstract,
      url: pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : '',
      keywords,
    };
  } catch {
    return null;
  }
}

function loadSummarizedPmids() {
  const path = resolve(ROOT, 'data', 'summarized_pmids.json');
  if (existsSync(path)) {
    try {
      const data = JSON.parse(readFileSync(path, 'utf-8'));
      return new Set(data.pmids || []);
    } catch {
      return new Set();
    }
  }
  return new Set();
}

function saveSummarizedPmids(pmids) {
  const dir = resolve(ROOT, 'data');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = resolve(dir, 'summarized_pmids.json');
  writeFileSync(path, JSON.stringify({ pmids: [...pmids].sort() }, null, 2), 'utf-8');
}

export async function fetchPapers(days = 7, maxPapers = 50) {
  const dateFilter = buildDateFilter(days);
  const allPmids = new Set();

  for (let i = 0; i < SEARCH_QUERIES.length; i++) {
    const fullQuery = `${SEARCH_QUERIES[i]} AND ${dateFilter}`;
    console.error(`[INFO] Query ${i + 1}/${SEARCH_QUERIES.length}...`);
    try {
      const pmids = await pubmedSearch(fullQuery, 20);
      pmids.forEach(id => allPmids.add(id));
    } catch (err) {
      console.error(`[WARN] Query ${i + 1} failed: ${err.message}`);
    }
  }

  console.error(`[INFO] Found ${allPmids.size} unique PMIDs total`);

  const summarized = loadSummarizedPmids();
  const newPmids = [...allPmids].filter(id => !summarized.has(id));
  console.error(`[INFO] ${newPmids.length} new papers (excluding ${summarized.size} already summarized)`);

  if (!newPmids.length) {
    return { date: getTaipeiDate(), count: 0, papers: [], newPmids: [] };
  }

  const limitedPmids = newPmids.slice(0, maxPapers);
  console.error(`[INFO] Fetching details for ${limitedPmids.length} papers...`);

  const papers = [];
  for (let i = 0; i < limitedPmids.length; i += 50) {
    const batch = limitedPmids.slice(i, i + 50);
    try {
      const batchPapers = await pubmedFetch(batch);
      papers.push(...batchPapers);
    } catch (err) {
      console.error(`[WARN] Batch fetch failed: ${err.message}`);
    }
  }

  console.error(`[INFO] Fetched details for ${papers.length} papers`);
  return {
    date: getTaipeiDate(),
    count: papers.length,
    papers,
    newPmids: limitedPmids,
  };
}

export { loadSummarizedPmids, saveSummarizedPmids, getTaipeiDate };
