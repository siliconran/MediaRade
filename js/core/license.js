/* =============================================================================
   license.js — strict licence verification.
   MediaRade by sgtsilicon

   Design principle, and the reason this file exists:

     Words in a title or description are a CLAIM, never a LICENCE.

   The only machine-readable, YouTube-asserted licence signal is the `license`
   field in the video's microformat, which yt-dlp surfaces as info.license and
   which only appears in FULL metadata (yt-dlp -J), never in a flat search
   listing. Everything else — "royalty free", "no copyright", "free to use" —
   is uploader marketing text and is treated as unverified until that field
   says otherwise. A video whose text claims free reuse while its licence field
   says Standard YouTube License is the single most common trap this panel
   exists to catch, and it is reported as a hard CONFLICT.

   Even a genuine Creative Commons mark only covers what the uploader actually
   owned. Embedded third-party music, stock footage and sublicensed libraries
   are flagged separately, because the uploader cannot relicense them.
   ========================================================================== */
(function (global) {
  'use strict';

  var CC_BY_3_URL = 'https://creativecommons.org/licenses/by/3.0/';

  /* --- tiers -------------------------------------------------------------- */

  var TIERS = {
    VERIFIED_CC_BY: {
      key: 'VERIFIED_CC_BY', tone: 'ok', seal: 'CC',
      title: 'Creative Commons BY 3.0',
      line: 'YouTube reports this upload as Creative Commons Attribution — reuse allowed. Attribution is mandatory.'
    },
    ALL_RIGHTS_RESERVED: {
      key: 'ALL_RIGHTS_RESERVED', tone: 'crit', seal: 'X',
      title: 'All rights reserved',
      line: 'Standard YouTube Licence. You have no reuse rights. Downloading for editing is not permitted without the rightsholder&rsquo;s permission.'
    },
    CONFLICT: {
      key: 'CONFLICT', tone: 'crit', seal: '!',
      title: 'Licence conflict',
      line: 'This upload advertises free reuse in its text but is published under the Standard YouTube Licence. The text is not a licence — the licence field wins.'
    },
    UNVERIFIED_CLAIM: {
      key: 'UNVERIFIED_CLAIM', tone: 'warn', seal: '?',
      title: 'Unverified claim',
      line: 'Free reuse is claimed in the text but no machine-readable licence has been confirmed. Run verification before using this.'
    },
    UNKNOWN: {
      key: 'UNKNOWN', tone: 'mute', seal: '-',
      title: 'Not verified',
      line: 'No licence information has been retrieved for this video yet.'
    }
  };

  /* --- pattern banks ------------------------------------------------------
     Each entry: [regex, id, label, detail]                                   */

  var CLAIM_PATTERNS = [
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

  var RESERVATION_PATTERNS = [
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

  /* Terms an uploader adds that CC BY does not actually permit them to add. */
  var RESTRICTION_PATTERNS = [
    [/non[\s-]?commercial( use)? only|not for commercial use/i, 'restrict.noncommercial', 'Says non-commercial only'],
    [/(do not|don't|cannot|can't) monetiz|no monetiz/i,         'restrict.nomonetize',    'Forbids monetisation'],
    [/must (subscribe|follow|like)/i,                           'restrict.social',        'Conditions use on following the channel'],
    [/only for (personal|private) use/i,                        'restrict.personal',      'Says personal use only']
  ];

  var ATTRIBUTION_PATTERNS = [
    [/(credit|attribution) (is )?(required|mandatory|must)|must (give )?credit|please credit|credit me/i,
     'oblig.credit', 'Uploader requires credit']
  ];

  /* Material the uploader almost certainly cannot sublicense to you. */
  var THIRD_PARTY_PATTERNS = [
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
  var REUPLOAD_PATTERNS = [
    [/\b(compilation|best of|top \d+|\d+\s*hours?)\b/i, 'risk.compilation', 'Looks like a compilation',
     'Compilations aggregate other people’s work; a licence set by the compiler rarely covers the parts.'],
    [/(free )?download (link )?(in )?(the )?(description|below)|dl link/i, 'risk.dllink', 'Offers an off-site download',
     'A redistribution link is a common marker of reuploaded material.'],
    [/\bre-?upload(ed)?\b/i, 'risk.reupload', 'Describes itself as a reupload',
     'The uploader is not the author, so they cannot set the licence.']
  ];

  /* --- helpers ------------------------------------------------------------ */

  function scan(text, bank) {
    var hits = [];
    if (!text) return hits;
    bank.forEach(function (row) {
      var m = text.match(row[0]);
      if (m) hits.push({ id: row[1], label: row[2], detail: row[3] || '', evidence: excerpt(text, m) });
    });
    return hits;
  }

  function excerpt(text, match) {
    var i = match.index === undefined ? text.indexOf(match[0]) : match.index;
    if (i < 0) return match[0];
    var start = Math.max(0, i - 45), end = Math.min(text.length, i + match[0].length + 45);
    return (start ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ').trim() + (end < text.length ? '…' : '');
  }

  function sig(severity, id, label, detail, evidence) {
    return { severity: severity, id: id, label: label, detail: detail || '', evidence: evidence || '' };
  }

  /* --- the engine --------------------------------------------------------- */

  var License = {
    TIERS: TIERS,
    CC_BY_3_URL: CC_BY_3_URL,

    /** Flat search entries carry no licence field, so they can never be trusted. */
    isFullMetadata: function (info) {
      return !!(info && (typeof info.license === 'string' || info.description !== undefined) && info._type !== 'url');
    },

    /**
     * @param {object} info  yt-dlp info dict (flat entry or full -J output)
     * @returns {object} report
     */
    evaluate: function (info) {
      info = info || {};

      var full        = License.isFullMetadata(info);
      var licenseText = typeof info.license === 'string' ? info.license : null;
      var title       = info.title || '';
      var description = info.description || '';
      var tagsText    = (info.tags || []).join(' ');
      var channel     = info.channel || info.uploader || '';
      var haystack    = [title, description, tagsText].join('\n');

      var isCC       = !!licenseText && /creative commons/i.test(licenseText);
      var isStandard = !!licenseText && /standard youtube licen[sc]e/i.test(licenseText);

      var claims       = scan(haystack, CLAIM_PATTERNS);
      var reservations = scan(description, RESERVATION_PATTERNS);
      var restrictions = scan(description, RESTRICTION_PATTERNS);
      var creditReqs   = scan(description, ATTRIBUTION_PATTERNS);
      var thirdParty   = scan(description, THIRD_PARTY_PATTERNS);
      var reupload     = scan(haystack, REUPLOAD_PATTERNS);

      var signals = [];
      var obligations = [];

      /* ---- 1. the authoritative field ---------------------------------- */
      if (isCC) {
        signals.push(sig('pos', 'yt.license.cc', 'YouTube licence field: Creative Commons',
          'This is the only machine-readable licence signal YouTube publishes, and it says reuse is allowed under CC BY 3.0.',
          licenseText));
      } else if (isStandard) {
        signals.push(sig('crit', 'yt.license.standard', 'YouTube licence field: Standard YouTube Licence',
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

      /* ---- 2. text claims are catalogued, never trusted ------------------ */
      claims.forEach(function (c) {
        signals.push(sig('info', c.id, c.label,
          'Marketing text, not a licence. Recorded as a claim only.', c.evidence));
      });

      /* ---- 3. the trap: claim vs field ----------------------------------- */
      var conflicted = false;
      if (claims.length && isStandard) {
        conflicted = true;
        signals.push(sig('crit', 'conflict.claim_vs_field', 'Claim contradicts the licence field',
          'The text advertises free reuse while YouTube reports Standard YouTube Licence. This is the classic mislabelled "royalty free" upload. Do not use it.',
          claims[0].evidence));
      }

      /* ---- 4. self-contradiction inside a CC upload ---------------------- */
      if (isCC && reservations.length) {
        signals.push(sig('crit', 'conflict.cc_vs_reservation', 'CC mark contradicted by the description',
          'The upload is marked Creative Commons but the description reserves rights. The uploader may have mis-set the licence, or may not own the material.',
          reservations[0].evidence));
      }
      reservations.forEach(function (r) {
        if (isCC) return;   // already folded into the conflict above
        signals.push(sig(isStandard ? 'warn' : 'crit', r.id, r.label,
          'The uploader is asserting rights over this material.', r.evidence));
      });

      /* ---- 5. terms CC BY does not allow the uploader to add -------------- */
      restrictions.forEach(function (r) {
        signals.push(sig('warn', r.id, r.label,
          isCC
            ? 'CC BY 3.0 permits commercial use and cannot be narrowed after the fact. The uploader’s intent is unclear, which is a licensing risk.'
            : 'The uploader is restricting how this may be used.',
          r.evidence));
      });

      /* ---- 6. material the uploader cannot sublicense --------------------- */
      thirdParty.forEach(function (t) {
        signals.push(sig(isCC ? 'crit' : 'warn', t.id, t.label, t.detail, t.evidence));
      });

      /* ---- 7. reupload shape ---------------------------------------------- */
      reupload.forEach(function (r) {
        signals.push(sig('warn', r.id, r.label, r.detail, r.evidence));
      });

      /* ---- 8. structured metadata that betrays commercial music ---------- */
      if (info.track || info.artist || info.album) {
        signals.push(sig(isCC ? 'crit' : 'warn', 'meta.musictrack', 'Carries commercial music metadata',
          'YouTube has matched this to a released recording (track/artist/album). Released recordings are essentially never the uploader’s to place under Creative Commons.',
          [info.track, info.artist, info.album].filter(Boolean).join(' — ')));
      }

      /* ---- 9. availability ------------------------------------------------ */
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
      if (info.channel_is_verified) {
        signals.push(sig('info', 'meta.verified', 'Verified channel',
          'Marginally raises confidence that the uploader is the rightsholder.'));
      }

      /* ---- 10. licence URL in the description ----------------------------- */
      var ccUrl = description.match(/creativecommons\.org\/licenses\/([a-z-]+)\/([\d.]+)/i);
      if (ccUrl) {
        var code = ccUrl[1].toLowerCase();
        var restrictive = /nc|nd/.test(code);
        signals.push(sig(restrictive ? 'warn' : 'info', 'desc.cc_url',
          'Description links CC ' + code.toUpperCase() + ' ' + ccUrl[2],
          restrictive
            ? 'That variant forbids commercial use and/or derivatives, which is narrower than the CC BY that YouTube’s own flag grants. Assume the narrower terms.'
            : 'Consistent with a Creative Commons release.',
          ccUrl[0]));
      }

      /* ---- tier ------------------------------------------------------------ */
      var tier;
      if (isCC)            tier = conflicted ? TIERS.CONFLICT : TIERS.VERIFIED_CC_BY;
      else if (isStandard) tier = claims.length ? TIERS.CONFLICT : TIERS.ALL_RIGHTS_RESERVED;
      else if (full)       tier = claims.length ? TIERS.UNVERIFIED_CLAIM : TIERS.ALL_RIGHTS_RESERVED;
      else                 tier = claims.length ? TIERS.UNVERIFIED_CLAIM : TIERS.UNKNOWN;

      // A CC upload contradicted by its own description is not a clean pass.
      if (isCC && signals.some(function (s) { return s.id === 'conflict.cc_vs_reservation'; })) tier = TIERS.CONFLICT;

      /* ---- confidence score ------------------------------------------------ */
      var score;
      if (tier === TIERS.VERIFIED_CC_BY) score = 88;
      else if (tier === TIERS.UNVERIFIED_CLAIM) score = 22;
      else if (tier === TIERS.UNKNOWN) score = 0;
      else score = 4;

      signals.forEach(function (s) {
        if (s.severity === 'crit') score -= 26;
        else if (s.severity === 'warn') score -= 9;
      });
      if (info.channel_is_verified) score += 4;
      if (ccUrl && !/nc|nd/.test(ccUrl[1])) score += 4;
      score = Math.round(U.clamp(score, 0, 100));

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
        if (thirdParty.length) obligations.push({
          key: 'Clear third-party content',
          text: 'This upload credits material the uploader does not own. Replace or separately clear it — the CC mark does not reach it.'
        });
      }
      creditReqs.forEach(function (c) {
        obligations.push({ key: 'Uploader asks for credit', text: c.evidence });
      });

      /* ---- gate ------------------------------------------------------------- */
      var blocking = signals.filter(function (s) {
        return s.severity === 'crit' && s.id !== 'yt.license.standard';
      });
      var cleanCC = (tier === TIERS.VERIFIED_CC_BY) && !blocking.length;

      var report = {
        tier: tier.key,
        tierInfo: tier,
        score: score,
        verified: full,
        licenseField: licenseText,
        isCC: isCC,
        isStandard: isStandard,
        requiresAttribution: isCC,
        signals: signals,
        obligations: obligations,
        claims: claims.map(function (c) { return c.label; }),
        counts: {
          crit: signals.filter(function (s) { return s.severity === 'crit'; }).length,
          warn: signals.filter(function (s) { return s.severity === 'warn'; }).length,
          pos:  signals.filter(function (s) { return s.severity === 'pos'; }).length
        },
        gate: {
          clean: cleanCC,
          allow: cleanCC,
          requireAck: !cleanCC,
          reasons: cleanCC ? [] : License.gateReasons(tier, full, blocking)
        },
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

    gateReasons: function (tier, full, blocking) {
      var out = [];
      if (!full) out.push('Licence has not been verified — full metadata was never fetched.');
      if (tier === TIERS.ALL_RIGHTS_RESERVED) out.push('All rights reserved: no reuse right exists.');
      if (tier === TIERS.CONFLICT) out.push('The reuse claim in the text contradicts the actual licence.');
      if (tier === TIERS.UNVERIFIED_CLAIM) out.push('A reuse claim was found but nothing confirms it.');
      blocking.forEach(function (s) { out.push(s.label + ' — ' + s.detail); });
      return out;
    },

    /** Build TASL attribution for a CC BY 3.0 YouTube upload. */
    attribution: function (info) {
      var title   = info.title || 'Untitled';
      var author  = info.channel || info.uploader || 'Unknown creator';
      var url     = info.webpage_url || (info.id ? U.watchUrl(info.id) : '');
      var chanUrl = info.channel_url || info.uploader_url || '';

      var plain = '"' + title + '" by ' + author + ' (' + (chanUrl || 'YouTube') + '), ' +
                  'source: ' + url + ', licensed under CC BY 3.0 (' + CC_BY_3_URL + ').';

      var html = '&ldquo;<a href="' + U.esc(url) + '">' + U.esc(title) + '</a>&rdquo; by ' +
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

    /** Compact badge descriptor for cards and rows. */
    badge: function (report) {
      if (!report) return { cls: 'mute', text: 'unchecked' };
      var map = {
        VERIFIED_CC_BY:      { cls: 'ok',   text: 'CC BY 3.0' },
        ALL_RIGHTS_RESERVED: { cls: 'crit', text: 'all rights reserved' },
        CONFLICT:            { cls: 'crit', text: 'licence conflict' },
        UNVERIFIED_CLAIM:    { cls: 'warn', text: 'unverified claim' },
        UNKNOWN:             { cls: 'mute', text: 'unchecked' }
      };
      return map[report.tier] || map.UNKNOWN;
    },

    /**
     * Current-policy allowance for a report. This is the single gate every
     * download path consults (the queue, the card buttons, the video view).
     * The `licenseMode` preset decides what counts as a pass:
     *   'cc'    — only a clean, machine-verified CC BY verdict
     *   'claim' — a "royalty free" / "no copyright" claim is accepted as
     *             best-effort evidence (UNVERIFIED_CLAIM tier) provided no
     *             critical signal contradicts it; a hard CONFLICT or a video
     *             that simply reserves all rights still blocks
     *   'all'   — everything passes; verification still runs and is displayed
     * Strict mode is a lock: it pins the policy to 'cc' whatever the preset.
     */
    allow: function (report) {
      if (!report) return false;
      var mode = Config.get('strictMode') ? 'cc' : (Config.get('licenseMode') || 'cc');
      if (mode === 'all') return true;
      if (mode === 'claim') {
        var t = report.tier;
        if (t !== TIERS.VERIFIED_CC_BY.key && t !== TIERS.UNVERIFIED_CLAIM.key) return false;
        return report.signals.every(function (s) {
          return s.severity !== 'crit' || s.id === 'yt.license.standard';
        });
      }
      return report.gate.allow;
    },

    /** Human label for the licence preset currently in force. */
    modeLabel: function () {
      if (Config.get('strictMode')) return 'Creative Commons only (locked)';
      var map = {
        cc: 'Creative Commons only',
        claim: 'Royalty free / claim-based',
        all: 'Everything (no gate)'
      };
      return map[Config.get('licenseMode')] || map.cc;
    },

    /** Wrap matched phrases in the description so the evidence is visible. */
    highlight: function (description, report) {
      if (!description) return '';
      var out = U.esc(description);
      var banks = [
        { bank: CLAIM_PATTERNS, cls: '' },
        { bank: RESERVATION_PATTERNS, cls: ' class="is-crit"' },
        { bank: RESTRICTION_PATTERNS, cls: ' class="is-crit"' },
        { bank: THIRD_PARTY_PATTERNS, cls: '' }
      ];
      banks.forEach(function (b) {
        b.bank.forEach(function (row) {
          var re = new RegExp(row[0].source, 'gi');
          out = out.replace(re, function (m) { return '<mark' + b.cls + '>' + m + '</mark>'; });
        });
      });
      return out;
    },

    /** Sidecar payload written next to every download. */
    sidecar: function (report, extra) {
      return Object.assign({
        _generator: 'MediaRade by sgtsilicon',
        _disclaimer: 'This record describes what YouTube reported at the time of download. ' +
                     'It is evidence of due diligence, not a grant of rights, and it is not legal advice. ' +
                     'An uploader can change a licence at any time, and an uploader can mark material ' +
                     'Creative Commons that they never had the right to license.',
        verdict: report.tier,
        verdictTitle: report.tierInfo.title,
        confidence: report.score,
        licenseField: report.licenseField,
        requiresAttribution: report.requiresAttribution,
        attribution: report.attribution,
        obligations: report.obligations,
        signals: report.signals,
        source: report.source,
        checkedAt: report.checkedAt
      }, extra || {});
    }
  };

  global.License = License;
})(window);
