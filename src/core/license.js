/* =============================================================================
   license.js — the media risk checker (License Auditor).
   MediaRade by rad1x

   This module replaces the old "licence type tag" system with a single,
   adversarial risk audit performed on every download and every video view:

       CRITICAL  — DO NOT USE. Content ID has already fingerprinted the audio
                   (music_sharing_info / track / artist / album), or the upload
                   is registered to an automated monetisation network. Never
                   overridable.
       HIGH      — Do not use without written permission. Monetisation traps,
                   derivative flags, mislabelled reuploads, or a risk that
                   cannot be conclusively ruled out. Overridable only with an
                   audited written reason.
       MODERATE  — Use with caution. Standard YouTube Licence (all rights
                   reserved to the uploader), Creative Commons NC/ND variants,
                   or third-party material credited but not cleared.
       LOW       — Safe to use. Machine-verified Creative Commons, no critical
                   or warning signals. Attribution still required.

   Core rules of the protocol this implements:
     1. Words in a title or description are a CLAIM, never a licence.
     2. The only platform-asserted licence signal is the `license` field in
        the full metadata dump (creativeCommon vs. Standard YouTube Licence).
     3. If a risk cannot be conclusively ruled out, default to HIGH.
     4. Automated tracking metadata (track/artist/album, music_sharing_info,
        licensed_to_youtube) means Content ID already owns the audio. That is
        an instant CRITICAL, irrespective of any text claims.
   ========================================================================== */
import U from './util.js';
import Config from './config.js';

const CC_BY_3_URL = 'https://creativecommons.org/licenses/by/3.0/';

/* --- risk levels --------------------------------------------------------- */

export const LEVELS = {
  CRITICAL: {
    key: 'CRITICAL', tone: 'crit', seal: '✕',
    title: 'CRITICAL RISK — DO NOT USE',
    line: 'This upload is already claimed by an automated enforcement system (Content ID fingerprint or a ' +
          'monetisation network). Downloading or editing it will almost certainly trigger a claim. MediaRade ' +
          'refuses it and no override is possible.'
  },
  HIGH: {
    key: 'HIGH', tone: 'crit', seal: '!',
    title: 'HIGH RISK',
    line: 'The uploader has not been shown to hold the rights this material needs. Either the text advertises ' +
          'free reuse that the licence field does not back up, or the material is a derivative/registered work. ' +
          'Do not use it without written permission from every rightsholder.'
  },
  MODERATE: {
    key: 'MODERATE', tone: 'warn', seal: '?',
    title: 'MODERATE RISK',
    line: 'Reuse is not cleanly established. This is usually a Standard YouTube Licence upload (all rights ' +
          'reserved to the uploader), a Creative Commons NC/ND variant, or material that credits third-party ' +
          'content. Proceed only with explicit confirmation of rights.'
  },
  LOW: {
    key: 'LOW', tone: 'ok', seal: '✓',
    title: 'LOW RISK',
    line: 'YouTube reports Creative Commons on the licence field, no automated claim is present, and nothing in ' +
          'the text contradicts it. Download is cleared — attribution is still required and will be written for you.'
  }
};

/* --- pattern banks ------------------------------------------------------
   Each entry: [regex, id, label, detail]                                   */

const CLAIM_PATTERNS = [
  [/royalty[\s-]*free/i,                          'claim.royaltyfree',  'Claims "royalty free"'],
  [/(no|zero)[\s-]*copyright|copyright[\s-]*free|non[\s-]?copyrighted/i, 'claim.nocopyright', 'Claims "no copyright"'],
  [/free (to|for) (use|download|commercial)/i,    'claim.freetouse',    'Claims "free to use"'],
  [/you (can|may) (freely )?use (this|it|these)/i,'claim.permission',   'Claims blanket permission'],
  [/\bcc0\b|public domain/i,                      'claim.publicdomain', 'Claims public domain / CC0'],
  [/creative commons/i,                           'claim.cc',           'Mentions Creative Commons'],
  [/no attribution (is )?(required|needed)/i,     'claim.noattrib',     'Claims no attribution required'],
  [/safe for (youtube|monetization|monetisation)/i,'claim.safe',        'Claims "safe for monetisation"'],
  [/100%\s*free|totally free|completely free/i,   'claim.100free',      'Claims "100% free"'],
  [/unlimited (use|usage|downloads)/i,            'claim.unlimited',    'Claims unlimited use']
];

/* Phase 2 trap #1: the upload is registered with a monetisation / Content ID
   network. Those distributors file automated claims; "free" text cannot. */
const MONETIZATION_PATTERNS = [
  [/\bidentifyy\b/i,                        'monetization.identifyy', 'Registered with Identifyy',
   'Identifyy is an automated Content ID distributor. Any use is claimed.'],
  [/\bdistrokid\b/i,                        'monetization.distrokid', 'Distributed via DistroKid',
   'DistroKid registers releases with Content ID. The track is tracked, not free.'],
  [/\bunecore\b/i,                          'monetization.tunecore', 'Distributed via TuneCore',
   'TuneCore registers releases with Content ID.'],
  [/\bcd\s*baby\b|\bcdbaby\b/i,             'monetization.cdbaby', 'Distributed via CD Baby',
   'CD Baby registers releases with Content ID.'],
  [/\blickd\b/i,                            'monetization.lickd', 'Licensed via Lickd',
   'Lickd is a commercial sync-licensing service; the upload is monetised.'],
  [/\bsync\s*id\b/i,                        'monetization.syncid', 'Uses Sync ID',
   'Sync ID enables automated Content ID claiming for cover music.'],
  [/\badrev\b/i,                            'monetization.adrev', 'Registered with AdRev',
   'AdRev is an automated Content ID enforcement network.'],
  [/\bcontent\s*id\b/i,                     'monetization.contentid', 'Mentions Content ID',
   'A Content ID mention on a "free" upload usually means the track is claimed.'],
  [/\blicensed\s*to\s*youtube\b/i,          'monetization.licensedyt', 'Licensed to YouTube',
   'The upload is licensed to YouTube for monetisation, not released to the public.']
];

/* Phase 2 trap #2: derivative works. The uploader rarely owns the underlying
   composition, so they cannot license it to you. */
const DERIVATIVE_PATTERNS = [
  [/(^|\b)(remix|bootleg|mashup|flip)\b/i,       'derivative.remix', 'Derivative work (remix/bootleg/mashup)',
   'The underlying composition is almost certainly owned by someone else.'],
  [/type\s*beat/i,                               'derivative.typebeat', 'A "type beat"',
   'Type beats emulate another artist\'s sound; the composition rights are not the uploader\'s to license.'],
  [/slowed\s*(\+|and|&)?\s*reverb/i,             'derivative.slowedreverb', 'Slowed + reverb edit',
   'A re-edit of a released recording.'],
  [/\bsped\s*up\b/i,                             'derivative.spedup', 'Sped-up edit',
   'A re-edit of a released recording.'],
  [/(^|\b)(cover)\b/i,                           'derivative.cover', 'A cover',
   'Covers need a mechanical licence from the composition owner that the uploader may or may not hold.']
];

const RESERVATION_PATTERNS = [
  [/all rights reserved/i,                        'reserve.arr',        'Text reserves all rights'],
  [/©|\(c\)\s*(19|20)\d{2}|copyright\s*(19|20)\d{2}/i, 'reserve.notice', 'Carries a copyright notice'],
  [/do not (re-?upload|re-?use|copy|redistribute|distribute)/i, 'reserve.donot', 'Forbids reuse or reupload'],
  [/re-?uploading (is )?(not allowed|prohibited|forbidden)/i, 'reserve.noreupload', 'Forbids reuploading'],
  [/unauthorized (use|reproduction|distribution)/i,'reserve.unauth',    'Warns against unauthorised use'],
  [/(will|shall) (be )?(strike|claim|dmca)/i,     'reserve.enforce',    'Threatens enforcement'],
  [/(written )?permission (is )?(required|needed)|ask (for )?permission/i, 'reserve.permission', 'Requires prior permission'],
  [/contact (me|us) (for|before|to)/i,            'reserve.contact',    'Directs you to ask first'],
  [/(purchase|buy|get) a licen[sc]e|licen[sc]ing (enquiries|inquiries|available)|licen[sc]e this (footage|clip|video|music)/i,
                                                'reserve.paid',       'Sells a separate licence']
];

/* Terms an uploader adds that a clean CC release does not permit. */
const RESTRICTION_PATTERNS = [
  [/non[\s-]?commercial( use)? only|not for commercial use/i, 'restrict.noncommercial', 'Says non-commercial only'],
  [/(do not|don't|cannot|can't) monetiz|no monetiz/i,         'restrict.nomonetize',    'Forbids monetisation'],
  [/must (subscribe|follow|like)/i,                           'restrict.social',        'Conditions use on following the channel'],
  [/only for (personal|private) use/i,                        'restrict.personal',      'Says personal use only']
];

const ATTRIBUTION_PATTERNS = [
  [/(credit|attribution) (is )?(required|mandatory|must)|must (give )?credit|please credit|credit me/i,
   'oblig.credit', 'Uploader requires credit']
];

/* Material the uploader almost certainly cannot sublicense to you. */
const THIRD_PARTY_PATTERNS = [
  [/epidemic sound|artlist\.io|\bartlist\b|audiojungle|soundstripe|musicbed|premiumbeat|envato|storyblocks/i,
   'thirdparty.library', 'Uses a subscription music/stock library',
   'Those licences are granted to the uploader personally and cannot be passed on to you, whatever the video licence says.'],
  [/\b(ncs|nocopyrightsounds)\b/i,
   'thirdparty.ncs', 'References NoCopyrightSounds (NCS)',
   'NCS tracks are released under NCS’s own terms, not Creative Commons. A CC mark on an NCS upload does not license the track.'],
  [/(music|song|track|beat)\s*(by|from|:|-)\s*\S/i,
   'thirdparty.music', 'Credits third-party music',
   'The video licence covers the uploader’s own contribution. A separately credited track keeps its own licence.'],
  [/(footage|clips?|images?|b-?roll)\s*(by|from|courtesy of|credit)/i,
   'thirdparty.footage', 'Credits third-party footage',
   'Borrowed shots are not covered by this uploader’s licence.'],
  [/pexels|pixabay|videvo|unsplash|mixkit|coverr/i,
   'thirdparty.stockfree', 'Sourced from a free-stock site',
   'Free-stock sites have their own terms. Go to the original source rather than relying on this reupload.'],
  [/prod\.?\s*by|beat by/i,
   'thirdparty.beat', 'Credits a producer',
   'Producer credits usually mean a separately owned recording.']
];

/* Shapes that correlate with mislabelled reuploads. */
const REUPLOAD_PATTERNS = [
  [/\b(compilation|best of|top \d+|\d+\s*hours?)\b/i, 'risk.compilation', 'Looks like a compilation',
   'Compilations aggregate other people’s work; a licence set by the compiler rarely covers the parts.'],
  [/(free )?download (link )?(in )?(the )?(description|below)|dl link/i, 'risk.dllink', 'Offers an off-site download',
   'A redistribution link is a common marker of reuploaded material.'],
  [/\bre-?upload(ed)?\b/i, 'risk.reupload', 'Describes itself as a reupload',
   'The uploader is not the author, so they cannot set the licence.']
];

/* Phase 3: aggregator channels — "no copyright music" archives are the classic
   source of retroactive Content ID claims, where a track is free today and
   registered next year. */
const AGGREGATOR_PATTERNS = [
  [/no\s*copyright\s*(background\s*)?(music|beats?|sounds?)/i, 'channel.aggregator.nocopyright', '"No copyright" music archive'],
  [/royalty\s*free\s*(background\s*)?(music|beats?|tracks?|sounds?)/i, 'channel.aggregator.royaltyfree', '"Royalty free" music archive'],
  [/(free|copyright[\s-]*free)\s*(music|beats?)\s*(library|archive|channel|tv)/i, 'channel.aggregator.freelib', 'Free-music library channel'],
  [/\b(free\s*)?(use|download)\s*free\s*(music|beats?)/i, 'channel.aggregator.usedl', 'Free-use archive channel'],
  [/\blofi\s*beat\b|\bambient\s*mix\b/i, 'channel.aggregator.lofi', 'Lofi/ambient stock channel']
];

/* --- helpers ------------------------------------------------------------ */

function scan(text, bank) {
  const hits = [];
  if (!text) return hits;
  bank.forEach(function (row) {
    const m = text.match(row[0]);
    if (m) hits.push({ id: row[1], label: row[2], detail: row[3] || '', evidence: excerpt(text, m) });
  });
  return hits;
}

function excerpt(text, match) {
  const i = match.index === undefined ? text.indexOf(match[0]) : match.index;
  if (i < 0) return match[0];
  const start = Math.max(0, i - 45), end = Math.min(text.length, i + match[0].length + 45);
  return (start ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ').trim() + (end < text.length ? '…' : '');
}

function sig(severity, id, label, detail, evidence) {
  return { severity: severity, id: id, label: label, detail: detail || '', evidence: evidence || '' };
}

const LEVEL_SCORE = { CRITICAL: 93, HIGH: 72, MODERATE: 41, LOW: 12 };

/* --- the engine --------------------------------------------------------- */

export const License = {
  LEVELS: LEVELS,
  CC_BY_3_URL: CC_BY_3_URL,

  /** Flat search entries carry no licence field, so they can never be trusted. */
  isFullMetadata: function (info) {
    return !!(info && (typeof info.license === 'string' || info.description !== undefined) && info._type !== 'url');
  },

  /** Risk level of a report (normalises legacy tier reports too). */
  level: function (report) {
    const n = License.normalize(report);
    return n ? n.level : null;
  },

  /**
   * Migrate old tier-based reports (stored library entries, ledger rows) to
   * the risk-level shape so nothing written before this version breaks.
   */
  normalize: function (report) {
    if (!report) return null;
    if (report.level && report.levelInfo && LEVELS[report.level]) return report;

    const LEGACY = {
      VERIFIED_CC_BY:      'LOW',
      UNVERIFIED_CLAIM:    'HIGH',
      CONFLICT:            'HIGH',
      ALL_RIGHTS_RESERVED: 'MODERATE',
      UNKNOWN:             'MODERATE'
    };
    const level = (LEVELS[report.level] && report.level) || LEGACY[report.tier] || 'MODERATE';
    const levelInfo = LEVELS[level];

    const signals = (report.signals || []).map(function (s) {
      return Object.assign({}, s);
    });

    const out = Object.assign({}, report, {
      level: level,
      levelInfo: levelInfo,
      tier: level,                       // legacy alias, same semantics now
      tierInfo: levelInfo,
      score: report.score != null ? report.score : LEVEL_SCORE[level],
      gate: report.gate || License._gateFor(level, signals, true),
      constraints: report.constraints || License._constraintsFor(level, report.isCC, report.requiresAttribution),
      verdict: report.verdict || License._verdictFor(level)
    });
    if (!out.counts) {
      out.counts = {
        crit: signals.filter(function (s) { return s.severity === 'crit'; }).length,
        warn: signals.filter(function (s) { return s.severity === 'warn'; }).length,
        pos:  signals.filter(function (s) { return s.severity === 'pos'; }).length
      };
    }
    return out;
  },

  /**
   * @param {object} info  yt-dlp info dict (flat entry or full -J output)
   * @returns {object} report
   */
  evaluate: function (info) {
    info = info || {};

    const full        = License.isFullMetadata(info);
    const licenseText = typeof info.license === 'string' ? info.license : null;
    const title       = info.title || '';
    const description = info.description || '';
    const tagsText    = (info.tags || []).join(' ');
    const channel     = info.channel || info.uploader || '';
    const haystack    = [title, description, tagsText].join('\n');

    const isCC       = !!licenseText && /creative commons/i.test(licenseText);
    const isStandard = !!licenseText && /standard youtube licen[sc]e/i.test(licenseText);

    /* ---- Phase 1: structural metadata inspection ---------------------- */

    const claims       = scan(haystack, CLAIM_PATTERNS);
    const monetization = scan(haystack, MONETIZATION_PATTERNS);
    const derivatives  = scan(title, DERIVATIVE_PATTERNS);
    const reservations = scan(description, RESERVATION_PATTERNS);
    const restrictions = scan(description, RESTRICTION_PATTERNS);
    const creditReqs   = scan(description, ATTRIBUTION_PATTERNS);
    const thirdParty   = scan(description, THIRD_PARTY_PATTERNS);
    const reupload     = scan(haystack, REUPLOAD_PATTERNS);
    const aggregator   = scan(channel, AGGREGATOR_PATTERNS);

    /* Content ID fingerprint — automated tracking blocks YouTube has set. */
    const contentIdFields = [];
    if (info.track)      contentIdFields.push('track="' + info.track + '"');
    if (info.artist)     contentIdFields.push('artist="' + info.artist + '"');
    if (info.album)      contentIdFields.push('album="' + info.album + '"');
    if (info.music_sharing_info) contentIdFields.push('music_sharing_info');
    if (info.licensed_to_youtube) contentIdFields.push('licensed_to_youtube');
    const contentId = contentIdFields.length > 0;

    /* CC subtype parsed from the description (narrower than the field). */
    let ccSubtype = null;
    const ccUrl = description.match(/creativecommons\.org\/licenses\/([a-z-]+)\/([\d.]+)/i);
    if (ccUrl) {
      const code = ccUrl[1].toLowerCase();
      ccSubtype = {
        code: code.toUpperCase(),
        nonCommercial: /nc/.test(code),
        noDerivatives: /nd/.test(code)
      };
    } else if (isCC) {
      const nc = /non[\s-]?commercial/i.test(description) || /\bby-nc\b/i.test(description);
      const nd = /no[\s-]?derivatives?\b/i.test(description) || /\bby-nd\b/i.test(description);
      if (nc || nd) ccSubtype = { code: (nc ? 'NC' : '') + (nd ? 'ND' : ''), nonCommercial: nc, noDerivatives: nd };
    }

    const signals = [];
    const obligations = [];

    /* ---- 1. platform licence field ------------------------------------- */
    if (isCC) {
      signals.push(sig('pos', 'yt.license.cc', 'YouTube licence field: Creative Commons',
        'This is the only machine-readable licence signal YouTube publishes, and it says reuse is allowed under CC BY 3.0.',
        licenseText));
    } else if (isStandard) {
      signals.push(sig('warn', 'yt.license.standard', 'YouTube licence field: Standard YouTube Licence',
        'All rights are reserved to the uploader. No reuse right is granted, regardless of what the description says.',
        licenseText));
    } else if (full) {
      signals.push(sig('warn', 'yt.license.absent', 'No licence field returned',
        'YouTube did not report a licence for this upload. Treat it as all rights reserved.',
        licenseText || '(empty)'));
    } else {
      signals.push(sig('info', 'yt.license.pending', 'Licence not retrieved yet',
        'Search listings do not include the licence field. Full metadata must be fetched before any verdict is possible.'));
    }

    /* ---- 2. automated claims / Content ID fingerprint ------------------ */
    if (contentId) {
      signals.push(sig('crit', 'meta.musictrack', 'Content ID fingerprint detected',
        'YouTube has already matched and claimed this recording (track/artist/album, music_sharing_info, or ' +
        'licensed_to_youtube). The audio is registered with Content ID — this is a hard DO NOT USE. ' +
        'No text claim can change that.',
        contentIdFields.join(' ')));
    }

    /* ---- 3. text claims are catalogued, never trusted ------------------- */
    claims.forEach(function (c) {
      signals.push(sig('info', c.id, c.label,
        'Marketing text, not a licence. Recorded as a claim only.', c.evidence));
    });

    /* ---- 4. monetisation networks --------------------------------------- */
    monetization.forEach(function (m) {
      signals.push(sig('crit', m.id, m.label, m.detail, m.evidence));
    });

    /* ---- 5. derivative flags -------------------------------------------- */
    derivatives.forEach(function (d) {
      signals.push(sig('crit', d.id, d.label, d.detail, d.evidence));
    });

    /* ---- 6. the trap: claim vs field ------------------------------------- */
    let conflicted = false;
    if (claims.length && isStandard) {
      conflicted = true;
      signals.push(sig('crit', 'conflict.claim_vs_field', 'Claim contradicts the licence field',
        'The text advertises free reuse while YouTube reports Standard YouTube Licence. This is the classic ' +
        'mislabelled "royalty free" upload. The licence field wins — treat as HIGH RISK.',
        claims[0].evidence));
    }

    /* ---- 7. CC mark contradicted by its own description ------------------ */
    if (isCC && reservations.length) {
      signals.push(sig('crit', 'conflict.cc_vs_reservation', 'CC mark contradicted by the description',
        'The upload is marked Creative Commons but the description reserves rights. The uploader may have ' +
        'mis-set the licence, or may not own the material.',
        reservations[0].evidence));
    }
    reservations.forEach(function (r) {
      if (isCC) return;   // already folded into the conflict above
      signals.push(sig(isStandard ? 'warn' : 'crit', r.id, r.label,
        'The uploader is asserting rights over this material.', r.evidence));
    });

    /* ---- 8. restrictions CC cannot carry --------------------------------- */
    restrictions.forEach(function (r) {
      signals.push(sig('warn', r.id, r.label,
        isCC
          ? 'CC BY 3.0 permits commercial use and cannot be narrowed after the fact. The uploader’s intent is unclear, which is a licensing risk.'
          : 'The uploader is restricting how this may be used.',
        r.evidence));
    });

    /* ---- 9. material the uploader cannot sublicense ---------------------- */
    thirdParty.forEach(function (t) {
      signals.push(sig(isCC ? 'crit' : 'warn', t.id, t.label, t.detail, t.evidence));
    });

    /* ---- 10. reupload shape ---------------------------------------------- */
    reupload.forEach(function (r) {
      signals.push(sig('warn', r.id, r.label, r.detail, r.evidence));
    });

    /* ---- 11. channel credibility ----------------------------------------- */
    if (aggregator.length) {
      signals.push(sig('warn', aggregator[0].id, 'Aggregator channel: ' + aggregator[0].label,
        'Dedicated "no copyright / royalty free" archives are historically high risk for retroactive Content ID ' +
        'claims — a track is free today and registered next year when it gains popularity. ' +
        'Get the source from the original rightsholder instead.',
        channel));
    }
    if (info.channel_is_verified) {
      signals.push(sig('pos', 'meta.verified', 'Verified channel',
        'Marginally raises confidence that the uploader is the rightsholder.'));
    }

    /* ---- 12. availability ------------------------------------------------ */
    if (info.age_limit) {
      signals.push(sig('info', 'meta.agelimit', 'Age-restricted',
        'Downloading needs browser cookies from a signed-in account.', 'age_limit=' + info.age_limit));
    }
    if (info.availability && info.availability !== 'public') {
      signals.push(sig('warn', 'meta.availability', 'Not a public video',
        'Restricted visibility often means the material was never meant for redistribution.', String(info.availability)));
    }
    if (info.is_live || info.was_live) {
      signals.push(sig('info', 'meta.live', 'Live or former live stream',
        'Live captures frequently contain third-party material the streamer does not own.'));
    }

    /* ---- 13. CC subtype from the description ----------------------------- */
    if (ccSubtype) {
      signals.push(sig(ccSubtype.nonCommercial || ccSubtype.noDerivatives ? 'warn' : 'info', 'desc.cc_url',
        'Creative Commons ' + ccSubtype.code + ' variant',
        ccSubtype.nonCommercial
          ? 'Non-Commercial: you cannot use this if your channel is monetised or you are a brand.'
          : ccSubtype.noDerivatives
            ? 'No Derivatives: you cannot cut, loop, or edit the length of this asset.'
            : 'Consistent with a permissive Creative Commons release.',
        ccUrl ? ccUrl[0] : ''));
    }

    /* ---- risk level ------------------------------------------------------- */
    let level;
    if (contentId) {
      level = 'CRITICAL';                                  // Content ID owns it. Full stop.
    } else if (monetization.length) {
      level = 'CRITICAL';                                  // registered with an enforcement network
    } else if (derivatives.length) {
      level = 'HIGH';
    } else if (isCC) {
      if (conflicted || reservations.length || thirdParty.some(function (t) { return t.id.indexOf('thirdparty') > -1 && !isStandard; })) {
        level = 'HIGH';
      } else if (ccSubtype && (ccSubtype.nonCommercial || ccSubtype.noDerivatives)) {
        level = 'MODERATE';
      } else {
        level = 'LOW';
      }
    } else if (isStandard) {
      level = claims.length ? 'HIGH' : 'MODERATE';
    } else if (full) {
      level = claims.length ? 'HIGH' : 'MODERATE';
    } else {
      level = 'MODERATE';
    }

    // any remaining critical signal (third-party on CC, restrictions, reuploads…)
    const anyCrit = signals.some(function (s) { return s.severity === 'crit' && s.id.indexOf('meta.musictrack') !== 0; });
    if (level === 'LOW' && anyCrit) level = 'HIGH';
    if (level !== 'CRITICAL' && aggregator.length && level === 'LOW') level = 'MODERATE';

    /* ---- constraints ------------------------------------------------------ */
    const constraints = License._constraintsFor(level, isCC, isCC, ccSubtype);

    /* ---- obligations ------------------------------------------------------ */
    if (isCC) {
      obligations.push({
        key: 'Attribution',
        text: 'CC BY 3.0 requires visible credit: title, creator, source link and licence. MediaRade writes this into attribution.txt and can stamp it as a timeline marker.'
      });
      obligations.push({
        key: 'Licence notice',
        text: 'Keep the CC BY 3.0 link (' + CC_BY_3_URL + ') with any published copy or derivative.'
      });
      obligations.push({
        key: 'No endorsement',
        text: 'Do not imply the creator endorses your edit.'
      });
    }
    if (ccSubtype && ccSubtype.nonCommercial) {
      obligations.push({
        key: 'Non-commercial only',
        text: 'This asset is Creative Commons Non-Commercial. You cannot use it in a monetised project or for a brand.'
      });
    }
    if (ccSubtype && ccSubtype.noDerivatives) {
      obligations.push({
        key: 'No derivatives',
        text: 'This asset is No Derivatives. You cannot cut, loop or edit it — use it only in its original form.'
      });
    }
    if (thirdParty.length) {
      obligations.push({
        key: 'Clear third-party content',
        text: 'This upload credits material the uploader does not own. Replace or separately clear it — the licence does not reach it.'
      });
    }
    if (aggregator.length) {
      obligations.push({
        key: 'Source from the owner',
        text: 'This is a no-copyright archive channel. Retroactive claims are common — go back to the original rightsholder before publishing.'
      });
    }
    creditReqs.forEach(function (c) {
      obligations.push({ key: 'Uploader asks for credit', text: c.evidence });
    });

    /* ---- risk score (0-100, higher = riskier) ---------------------------- */
    let score = LEVEL_SCORE[level];
    signals.forEach(function (s) {
      if (s.severity === 'crit') score += 14;
      else if (s.severity === 'warn') score += 6;
      else if (s.severity === 'pos') score -= 4;
    });
    if (info.channel_is_verified) score -= 3;
    score = Math.round(U.clamp(score, 2, 99));

    /* ---- verdict text ----------------------------------------------------- */
    const verdict = License._verdictFor(level);

    /* ---- gate -------------------------------------------------------------- */
    const blocking = signals.filter(function (s) { return s.severity === 'crit'; });
    const gate = License._gateFor(level, signals);

    const report = {
      level: level,
      levelInfo: LEVELS[level],
      tier: level,                       // legacy alias
      tierInfo: LEVELS[level],
      score: score,
      verified: full,
      licenseField: licenseText,
      isCC: isCC,
      isStandard: isStandard,
      requiresAttribution: isCC || creditReqs.length > 0,
      contentId: contentId,
      signals: signals,
      obligations: obligations,
      claims: claims.map(function (c) { return c.label; }),
      monetizationTraps: monetization.map(function (m) { return m.label; }),
      derivativeFlags: derivatives.map(function (d) { return d.label; }),
      counts: {
        crit: signals.filter(function (s) { return s.severity === 'crit'; }).length,
        warn: signals.filter(function (s) { return s.severity === 'warn'; }).length,
        pos:  signals.filter(function (s) { return s.severity === 'pos'; }).length
      },
      technical: {
        platformLicense: isCC ? 'Creative Commons (CC BY 3.0)' : (isStandard ? 'Standard YouTube Licence' : 'None reported'),
        contentIdDetected: contentId,
        contentIdSignals: contentIdFields
      },
      audit: {
        statedLicense: claims.some(function (c) { return /claim\.cc/i.test(c.id); }) ? 'Creative Commons (stated in text)' : 'None stated',
        monetizationTraps: monetization.map(function (m) { return m.label; }),
        derivativeFlags: derivatives.map(function (d) { return d.label; }),
        ccSubtype: ccSubtype
      },
      constraints: constraints,
      verdict: verdict,
      gate: gate,
      attribution: isCC ? License.attribution(info) : null,
      checkedAt: new Date().toISOString(),
      source: {
        id: info.id || null,
        title: title,
        channel: channel,
        channelUrl: info.channel_url || info.uploader_url || null,
        url: info.webpage_url || (info.id ? U.watchUrl(info.id) : null),
        uploadDate: info.upload_date || null,
        duration: info.duration || null
      }
    };

    return report;
  },

  _constraintsFor: function (level, isCC, attributionRequired, ccSubtype) {
    let commercial = 'restricted', modification = 'restricted';
    if (level === 'LOW') { commercial = 'yes'; modification = 'yes'; }
    else if (level === 'MODERATE') {
      if (isCC && ccSubtype) {
        commercial = ccSubtype.nonCommercial ? 'no' : 'yes';
        modification = ccSubtype.noDerivatives ? 'no' : 'yes';
      } else if (isCC) { commercial = 'yes'; modification = 'yes'; }
      else { commercial = 'restricted'; modification = 'restricted'; }
    }
    if (level === 'HIGH' || level === 'CRITICAL') { commercial = 'no'; modification = 'no'; }

    return {
      commercialUse: commercial,
      modification: modification,
      attributionRequired: !!attributionRequired,
      attributionText: attributionRequired ? 'See the credit block written to attribution.txt / CREDITS.md at download time.' : null
    };
  },

  _verdictFor: function (level) {
    const map = {
      LOW: 'Safe to use. Download is cleared: YouTube reports Creative Commons, no automated claim is present, and ' +
           'nothing in the text contradicts it. Copy the attribution block into your credits exactly as written.',
      MODERATE: 'Use with caution. Reuse rights are not cleanly established — either the upload is under the Standard ' +
           'YouTube Licence (rights stay with the uploader) or it carries restrictions. Treat it as cleared only if you ' +
           'have written permission from every rightsholder; keep the .license.json record either way.',
      HIGH: 'Do not use without written permission. The uploader has not been shown to hold the rights this needs ' +
           '— mislabelled "royalty free" uploads and derivative/registered works are the top cause of Content ID ' +
           'strikes. If you genuinely hold permission, record it and override; the reason is written to the ledger.',
      CRITICAL: 'DO NOT USE. This audio is already claimed by an automated enforcement system (Content ID fingerprint ' +
           'or a monetisation network). Downloading, editing or publishing it will almost certainly trigger a claim ' +
           'or a strike. No override is offered, by design.'
    };
    return { level: level, text: map[level] };
  },

  _gateFor: function (level, signals) {
    const blocking = signals.filter(function (s) { return s.severity === 'crit'; });
    const reasons = License.gateReasons(level, blocking);
    const clean = level === 'LOW' && blocking.length === 0;
    return {
      clean: clean,
      allow: clean,
      requireAck: !clean,
      hard: level === 'CRITICAL',
      overridable: level === 'HIGH',
      reasons: reasons
    };
  },

  gateReasons: function (level, blocking) {
    const out = [];
    if (level === 'CRITICAL') out.push('DO NOT USE — automated enforcement already claims this material. No override is possible.');
    if (level === 'HIGH') out.push('High risk: the uploader has not been shown to hold the rights this material needs.');
    if (level === 'MODERATE') out.push('Moderate risk: reuse rights are not cleanly established.');
    (blocking || []).forEach(function (s) { out.push(s.label + ' — ' + s.detail); });
    return out;
  },

  /**
   * The single gate every download path consults (the queue, the card buttons,
   * the video view). Strict mode admits only LOW risk; otherwise LOW and
   * MODERATE pass, HIGH is overridable, and CRITICAL never passes.
   */
  allow: function (report) {
    const r = License.normalize(report);
    if (!r) return false;

    // Pre-cleared library providers (Uppbeat) carry their own verdict.
    if (r.provider && r.provider !== 'youtube' && r.gate && r.gate.allow) return true;

    // CRITICAL means an automated enforcement system already owns the audio.
    // No policy setting unlocks that, by design.
    if (r.level === 'CRITICAL') return false;

    switch (License.mode()) {
      case 'all':   return r.level !== 'CRITICAL';          // warnings only
      case 'claim': return r.level === 'LOW' || r.level === 'MODERATE';
      default:      return r.level === 'LOW';               // 'cc'
    }
  },

  /** The policy actually in force. Strict mode pins it to Creative Commons. */
  mode: function () {
    if (Config.get('strictMode')) return 'cc';
    const m = Config.get('licenseMode');
    return (m === 'claim' || m === 'all') ? m : 'cc';
  },

  /** What stands between this report and a clean download. */
  blocked: function (report) {
    const r = License.normalize(report);
    if (!r) return { allowed: false, hard: false, overridable: true, reasons: ['Licence has not been verified.'] };
    const allowed = License.allow(r);
    if (allowed) return { allowed: true, hard: false, overridable: false, reasons: [] };
    return {
      allowed: false,
      hard: r.level === 'CRITICAL',
      // Anything short of CRITICAL can be taken anyway, after an explicit
      // confirmation that is written to the ledger. CRITICAL means an automated
      // enforcement system already owns the audio, so no confirmation helps.
      overridable: r.level !== 'CRITICAL',
      reasons: r.gate.reasons
    };
  },

  /** Human label for the policy currently in force. */
  modeLabel: function () {
    if (Config.get('strictMode')) return 'strict — verified Creative Commons only';
    switch (License.mode()) {
      case 'all':   return 'unrestricted — warnings only, CRITICAL still blocked';
      case 'claim': return 'royalty free — LOW and MODERATE pass, HIGH needs a confirmation';
      default:      return 'Creative Commons only — LOW risk passes, everything else is refused';
    }
  },

  /**
   * Current-policy allowance given only a stored verdict string (ledger rows,
   * legacy tier names). 'low' is the only pass under strict mode.
   */
  badgeFromVerdict: function (verdict) {
    const r = License.normalize({ tier: verdict, level: verdict && LEVELS[verdict] ? verdict : null });
    const map = {
      CRITICAL: { cls: 'crit', text: 'CRITICAL · DO NOT USE' },
      HIGH:     { cls: 'crit', text: 'HIGH RISK' },
      MODERATE: { cls: 'warn', text: 'MODERATE RISK' },
      LOW:      { cls: 'ok',   text: 'LOW RISK' }
    };
    const m = map[r ? r.level : ''] || map.MODERATE;
    return m;
  },

  /** Compact badge descriptor for cards and rows. */
  badge: function (report) {
    const r = License.normalize(report);
    if (!r) return { cls: 'mute', text: 'unchecked', level: null };
    const map = {
      CRITICAL: { cls: 'crit', text: 'CRITICAL · DO NOT USE' },
      HIGH:     { cls: 'crit', text: 'HIGH RISK' },
      MODERATE: { cls: 'warn', text: 'MODERATE RISK' },
      LOW:      { cls: 'ok',   text: 'LOW RISK' }
    };
    return Object.assign({ level: r.level }, map[r.level] || map.MODERATE);
  },

  /** Build TASL attribution for a CC BY 3.0 YouTube upload. */
  attribution: function (info) {
    const title   = info.title || 'Untitled';
    const author  = info.channel || info.uploader || 'Unknown creator';
    const url     = info.webpage_url || (info.id ? U.watchUrl(info.id) : '');
    const chanUrl = info.channel_url || info.uploader_url || '';

    const plain = '"' + title + '" by ' + author + ' (' + (chanUrl || 'YouTube') + '), ' +
                  'source: ' + url + ', licensed under CC BY 3.0 (' + CC_BY_3_URL + ').';

    const html = '&ldquo;<a href="' + U.esc(url) + '">' + U.esc(title) + '</a>&rdquo; by ' +
                 (chanUrl ? '<a href="' + U.esc(chanUrl) + '">' + U.esc(author) + '</a>' : U.esc(author)) +
                 ', licensed under <a href="' + CC_BY_3_URL + '">CC BY 3.0</a>.';

    return {
      title: title, author: author, source: url, channelUrl: chanUrl,
      license: 'CC BY 3.0', licenseUrl: CC_BY_3_URL,
      plain: plain,
      html: html,
      credits: plain + ' Modified for use in this production.',
      marker: 'CC BY 3.0 — ' + title + ' — ' + author + ' — ' + url
    };
  },

  /** Wrap matched phrases in the description so the evidence is visible. */
  highlight: function (description, report) {
    if (!description) return '';
    let out = U.esc(description);
    const banks = [
      { bank: CLAIM_PATTERNS, cls: '' },
      { bank: MONETIZATION_PATTERNS, cls: ' class="is-crit"' },
      { bank: DERIVATIVE_PATTERNS, cls: ' class="is-crit"' },
      { bank: RESERVATION_PATTERNS, cls: ' class="is-crit"' },
      { bank: RESTRICTION_PATTERNS, cls: ' class="is-crit"' },
      { bank: THIRD_PARTY_PATTERNS, cls: '' }
    ];
    banks.forEach(function (b) {
      b.bank.forEach(function (row) {
        const re = new RegExp(row[0].source, 'gi');
        out = out.replace(re, function (m) { return '<mark' + b.cls + '>' + m + '</mark>'; });
      });
    });
    return out;
  },

  /** Sidecar payload written next to every download. */
  sidecar: function (report, extra) {
    const r = License.normalize(report);
    return Object.assign({
      _generator: 'MediaRade by rad1x',
      _disclaimer: 'This record describes what YouTube reported at the time of download. ' +
                   'It is evidence of due diligence, not a grant of rights, and it is not legal advice. ' +
                   'An uploader can change a licence at any time, and an uploader can mark material ' +
                   'Creative Commons that they never had the right to license.',
      riskLevel: r.level,
      riskTitle: r.levelInfo.title,
      riskScore: r.score,
      licenseField: r.licenseField,
      contentIdDetected: r.contentId,
      requiresAttribution: r.requiresAttribution,
      attribution: r.attribution,
      constraints: r.constraints,
      obligations: r.obligations,
      signals: r.signals,
      verdict: r.verdict,
      source: r.source,
      checkedAt: r.checkedAt
    }, extra || {});
  }
};

export default License;
