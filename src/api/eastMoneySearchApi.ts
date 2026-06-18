import { httpGetJson } from './httpClient';
import {
  EM_QUOTE_ID_TO_SINA,
  normalizeEmSecId,
  sinaCodeFromEmQuoteId,
} from './eastMoneySecId';
import { normalizeInstrumentCode, SINA_INSTRUMENTS } from './instruments';
import { SearchResult } from '../models/types';

const EM_SEARCH_URL = 'https://searchapi.eastmoney.com/api/suggest/get';
const EM_SEARCH_TOKEN = 'D43AE275-469E-4AE0-8044-1C0F3E27A341';

/** 东财搜索中适合作为环球品种添加的分类（A 股/港美仍优先腾讯搜索） */
const GLOBAL_CLASSIFY = new Set([
  'UniversalIndex',
  'UniversalFutures',
  'FORPM',
  'HKPM',
]);

const EM_SECID_PATTERN = /^\d+\.[A-Za-z0-9.-]+$/;

interface EmSearchRow {
  Code?: string;
  Name?: string;
  PinYin?: string;
  Classify?: string;
  QuoteID?: string;
  UnifiedCode?: string;
  SecurityTypeName?: string;
}

interface EmSearchResponse {
  QuotationCodeTable?: {
    Data?: EmSearchRow[];
  };
}

function matchSinaByName(name: string): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) {
    return undefined;
  }
  const exact = SINA_INSTRUMENTS.find((item) => item.name === trimmed);
  if (exact) {
    return normalizeInstrumentCode(exact.code);
  }
  const partial = SINA_INSTRUMENTS.find(
    (item) => trimmed.includes(item.name) || item.name.includes(trimmed)
  );
  return partial ? normalizeInstrumentCode(partial.code) : undefined;
}

function resolveStorageCode(item: EmSearchRow, quoteId: string): string | undefined {
  const fromQuote = sinaCodeFromEmQuoteId(quoteId);
  if (fromQuote) {
    return fromQuote;
  }

  const unified = item.UnifiedCode?.toLowerCase();
  if (unified) {
    const byKeyword = SINA_INSTRUMENTS.find((inst) =>
      inst.keywords.some((kw) => kw.toLowerCase() === unified)
    );
    if (byKeyword) {
      return normalizeInstrumentCode(byKeyword.code);
    }
  }

  return matchSinaByName(item.Name ?? '');
}

function scoreEmRow(keyword: string, item: EmSearchRow): number {
  const kw = keyword.toLowerCase();
  const name = (item.Name ?? '').toLowerCase();
  const code = (item.Code ?? '').toLowerCase();
  const pinyin = (item.PinYin ?? '').toLowerCase();
  const quoteId = normalizeEmSecId(item.QuoteID ?? '').toLowerCase();

  if (name === kw || code === kw || quoteId.endsWith(`.${kw}`)) {
    return 100;
  }
  if (pinyin === kw) {
    return 95;
  }
  if (name.includes(kw) || code.includes(kw) || pinyin.includes(kw)) {
    return 80;
  }
  if (EM_QUOTE_ID_TO_SINA[normalizeEmSecId(item.QuoteID ?? '')]) {
    return 70;
  }
  return 0;
}

function mapEmRow(item: EmSearchRow): SearchResult | undefined {
  const quoteId = item.QuoteID?.trim();
  if (!quoteId || !EM_SECID_PATTERN.test(quoteId)) {
    return undefined;
  }

  const normalizedQuoteId = normalizeEmSecId(quoteId);
  const code = resolveStorageCode(item, normalizedQuoteId);
  if (!code) {
    return undefined;
  }

  return {
    code,
    name: item.Name?.trim() || code,
    market: 'global',
    secid: normalizedQuoteId,
  };
}

/** 东财关键字搜索，返回带 secid 的环球品种（指数/期货/贵金属现货） */
export async function searchEastMoneyInstruments(keyword: string): Promise<SearchResult[]> {
  const trimmed = keyword.trim();
  if (!trimmed) {
    return [];
  }

  const url = new URL(EM_SEARCH_URL);
  url.searchParams.set('input', trimmed);
  url.searchParams.set('type', '14');
  url.searchParams.set('token', EM_SEARCH_TOKEN);
  url.searchParams.set('count', '20');

  const body = await httpGetJson<EmSearchResponse>(url.toString(), {
    headers: {
      Referer: 'https://quote.eastmoney.com/',
      'User-Agent': 'Mozilla/5.0',
    },
  });

  return (body.QuotationCodeTable?.Data ?? [])
    .filter((row) => row.Classify && GLOBAL_CLASSIFY.has(row.Classify))
    .map((row) => ({ row, score: scoreEmRow(trimmed, row) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ row }) => mapEmRow(row))
    .filter((item): item is SearchResult => item !== undefined);
}
