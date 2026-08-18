// SPDX-License-Identifier: Apache-2.0
/**
 * Negative controls for the licence census — ruling 72.
 *
 * The census is the substantial half of the LGPL work: JavaScriptCore is not
 * uniformly LGPL, and ruling 72 names the gap as ours rather than upstream's —
 * "enumerating those files' attribution properly is work nobody has done". The
 * enumeration is only worth anything if the classifier is right, so every
 * classification below is driven with a REAL header, copied out of the pinned
 * source, and with a header that must NOT classify that way.
 *
 * The headers are excerpts from `oven-sh/WebKit` at
 * 5488984d20e0dbfe4be2c3ba8fb18eb81a5e0e8b and `oven-sh/tinycc` at
 * 12882eee073cfe5c7621bcfadf679e1372d4537b, READ 2026-08-17.
 */

import { describe, expect, test } from "bun:test";
import {
  classifyLicenceHeader,
  hasLinkingException,
  holdersIn,
  noticeIn,
  readCensuses,
  saysOrLater,
  allComponents,
  pins,
  PROPRIETARY_MARKERS,
} from "../scripts/inventory.ts";

/** Source/JavaScriptCore/runtime/JSObject.h — the KDE-lineage LGPL half. */
const REAL_LGPL_HEADER = `/*
 *  Copyright (C) 1999-2001 Harri Porten (porten@kde.org)
 *  Copyright (C) 2001 Peter Kelly (pmk@post.com)
 *  Copyright (C) 2003-2019 Apple Inc. All rights reserved.
 *
 *  This library is free software; you can redistribute it and/or
 *  modify it under the terms of the GNU Library General Public
 *  License as published by the Free Software Foundation; either
 *  version 2 of the License, or (at your option) any later version.
 */`;

/** Source/JavaScriptCore/bytecompiler/StaticPropertyAnalyzer.h — the BSD majority. */
const REAL_BSD2_HEADER = `/*
 * Copyright (C) 2012 Apple Inc. All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions
 * are met:
 * 1. Redistributions of source code must retain the above copyright
 *    notice, this list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright
 *    notice, this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 *
 * THIS SOFTWARE IS PROVIDED BY APPLE INC. \`\`AS IS'' AND ANY
 * EXPRESS OR IMPLIED WARRANTIES ARE DISCLAIMED. IN NO EVENT SHALL APPLE INC.
 * BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
 * CONSEQUENTIAL DAMAGES, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */`;

/** Source/WTF/wtf/dtoa/LICENSE — the three-clause form, with the endorsement clause. */
const REAL_BSD3_HEADER = `Copyright 2006-2011, the V8 project authors. All rights reserved.
Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:
    * Redistributions of source code must retain the above copyright
      notice, this list of conditions and the following disclaimer.
    * Neither the name of Google Inc. nor the names of its
      contributors may be used to endorse or promote products derived
      from this software without specific prior written permission.
THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS "AS IS" AND ANY
EXPRESS OR IMPLIED WARRANTIES ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER BE LIABLE FOR ANY DAMAGES, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`;

/** tinycc lib/libtcc1.c — plain GPL, WITH the linking exception. */
const REAL_GPL_WITH_EXCEPTION = `/* TCC runtime library.
   Copyright (C) 1987, 1988, 1992, 1994, 1995 Free Software Foundation, Inc.

This file is free software; you can redistribute it and/or modify it
under the terms of the GNU General Public License as published by the
Free Software Foundation; either version 2, or (at your option) any
later version.

In addition to the permissions in the GNU General Public License, the
Free Software Foundation gives you unlimited permission to link the
compiled version of this file into combinations with other programs,
and to distribute those combinations without any restriction coming
from the use of this file.
*/`;

describe("the licence classifier", () => {
  test("classifies the real LGPL, BSD-2, BSD-3 and GPL headers from the pinned source", () => {
    expect(classifyLicenceHeader(REAL_LGPL_HEADER)).toBe("LGPL");
    expect(classifyLicenceHeader(REAL_BSD2_HEADER)).toBe("BSD-2-Clause");
    expect(classifyLicenceHeader(REAL_BSD3_HEADER)).toBe("BSD-3-Clause");
    expect(classifyLicenceHeader(REAL_GPL_WITH_EXCEPTION)).toBe("GPL");
  });

  test("does NOT call a BSD file LGPL, which is the mistake the flat label made", () => {
    // The whole point of the census. Ruling 72: a flat "LGPL-2" label both
    // overstates the licence of 3,954 BSD files and understates the attribution
    // they separately require.
    expect(classifyLicenceHeader(REAL_BSD2_HEADER)).not.toBe("LGPL");
    expect(classifyLicenceHeader(REAL_BSD3_HEADER)).not.toBe("LGPL");
  });

  test("does NOT call a plain-GPL file LGPL", () => {
    expect(classifyLicenceHeader(REAL_GPL_WITH_EXCEPTION)).not.toBe("LGPL");
  });

  test("separates the two BSD forms on the endorsement clause, not on guesswork", () => {
    const three = REAL_BSD2_HEADER.replace(
      "THIS SOFTWARE IS PROVIDED",
      "3. Neither the name of the copyright holder may be used to endorse products.\n * THIS SOFTWARE IS PROVIDED",
    );
    expect(classifyLicenceHeader(three)).toBe("BSD-3-Clause");
  });

  test("says unclassified rather than guessing", () => {
    expect(classifyLicenceHeader("#!/bin/sh\n# generated file, no header\n")).toBe("unclassified");
    expect(classifyLicenceHeader("")).toBe("unclassified");
  });

  test("recognises MIT and Apache without calling either of them a BSD", () => {
    expect(classifyLicenceHeader("Permission is hereby granted, free of charge, to any person")).toBe("MIT-like");
    expect(classifyLicenceHeader("Licensed under the Apache License, Version 2.0")).toBe("Apache-2.0");
  });
});

describe("the version election the headers offer", () => {
  test("reads 'or (at your option) any later version' out of a real header", () => {
    // Ruling 72's first correction: our flat "LGPL-2" label read as the
    // strictest possible version, while the headers let a recipient elect 2.1
    // or 3. MEASURED at the pinned revision: 297 of WebKit's 302 LGPL files say
    // it — so it is a majority, not a universal, and the number is printed.
    expect(saysOrLater(REAL_LGPL_HEADER)).toBe(true);
  });

  test("FAILS to find it in a version-2-only header", () => {
    expect(saysOrLater(REAL_LGPL_HEADER.replace(", or (at your option) any later version", ""))).toBe(false);
  });

  test("is not fooled by the line wrapping a comment block imposes", () => {
    const wrapped = " * version 2 of the License, or (at your\n * option) any later version.";
    expect(saysOrLater(wrapped)).toBe(true);
  });
});

describe("the GPL linking exception", () => {
  test("finds it in tinycc's libtcc1.c, the file that is actually linked", () => {
    expect(hasLinkingException(REAL_GPL_WITH_EXCEPTION)).toBe(true);
  });

  test("does NOT find it in a plain GPL header", () => {
    expect(hasLinkingException(REAL_GPL_WITH_EXCEPTION.split("In addition to the permissions")[0] as string)).toBe(
      false,
    );
  });
});

describe("copyright holders", () => {
  test("enumerates every holder in a real multi-holder header, years dropped", () => {
    expect(holdersIn(REAL_LGPL_HEADER)).toEqual([
      "Harri Porten (porten@kde.org)",
      "Peter Kelly (pmk@post.com)",
      "Apple Inc. All rights reserved.",
    ]);
  });

  test("normalises © to (c), so generated attribution cannot trip the marker scan", () => {
    // Not hypothetical: WebKit carries `Copyright (C) 2026 Anthropic PBC.` in 8
    // files at the pinned revision (MEASURED 2026-08-17), and one of the
    // gate's proprietary markers is "© Anthropic PBC. All rights reserved.".
    const holders = holdersIn("Copyright © 2026 Anthropic PBC. All rights reserved.");
    expect(holders).toEqual(["Anthropic PBC. All rights reserved."]);
    for (const marker of PROPRIETARY_MARKERS) expect(holders.join(" ")).not.toContain(marker);
  });

  test("returns nothing for a header with no notice, rather than an empty holder", () => {
    expect(holdersIn("/* generated file */")).toEqual([]);
    expect(holdersIn("Copyright 2020")).toEqual([]);
  });
});

describe("the BSD notice block", () => {
  test("extracts the conditions and the disclaimer, and stops at the disclaimer's end", () => {
    const notice = noticeIn(REAL_BSD2_HEADER);
    expect(notice).toBeDefined();
    expect(notice).toStartWith("Redistribution and use in source and binary forms");
    expect(notice).toEndWith("EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.");
    expect(notice).not.toContain("*");
  });

  test("returns undefined for a header that carries no BSD notice", () => {
    expect(noticeIn(REAL_LGPL_HEADER)).toBeUndefined();
  });

  test("collapses comment furniture so one wording counts once", () => {
    const asHash = REAL_BSD2_HEADER.split("\n").map((l) => l.replace(/^ \*/, "#")).join("\n");
    expect(noticeIn(asHash)).toBe(noticeIn(REAL_BSD2_HEADER) as string);
  });
});

describe("the committed census", () => {
  const censuses = readCensuses();

  test("covers every LGPL library the inventory says is in the binary", () => {
    for (const c of allComponents()) {
      if (!c.lgpl) continue;
      expect({ component: c.name, censused: censuses[c.name] !== undefined }).toEqual({
        component: c.name,
        censused: true,
      });
    }
  });

  test("was taken at the revision that is pinned, not some other one", () => {
    // The census is a snapshot against a commit that moves. If it were taken at
    // a different revision than the one the source offer names, every number in
    // the generated attribution would describe a library nobody received.
    for (const [name, census] of Object.entries(censuses)) {
      expect({ name, revision: census.revision }).toEqual({ name, revision: pins()[name] as string });
    }
  });

  test("records a date and a tool for every figure, never a bare number", () => {
    for (const census of Object.values(censuses)) {
      expect(census.measuredOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(census.measuredWith).toContain("git");
      expect(census.headerBytes).toBeGreaterThan(0);
    }
  });

  test("the population totals add up to the files walked", () => {
    for (const census of Object.values(censuses)) {
      const walked = census.populations.reduce((sum, p) => sum + p.files, 0);
      const classified = Object.values(census.totals).reduce((sum, n) => sum + n, 0);
      expect({ walked, classified }).toEqual({ walked, classified: walked });
    }
  });

  test("the BSD attribution is an enumeration and not a summary", () => {
    // Ruling 72 left this open: "enumerating those files' attribution properly
    // is work nobody has done". A census with counts but no holders would look
    // identical to one that did the work.
    const webkit = censuses["javascriptcore-webkit"];
    expect(webkit).toBeDefined();
    const bsdHolders = (webkit?.holders ?? []).filter((h) => h.class.startsWith("BSD"));
    expect(bsdHolders.length).toBeGreaterThan(50);
    expect(webkit?.notices.length).toBeGreaterThan(0);
    for (const notice of webkit?.notices ?? []) {
      expect(notice.text).toContain("Redistribution and use in source and binary forms");
      expect(notice.example.length).toBeGreaterThan(0);
    }
  });
});

describe("what the generated notice says about the obligation", () => {
  const lgplComponents = allComponents().filter((c) => c.lgpl);

  test("there are LGPL components at all, and each carries its verbatim licence", () => {
    expect(lgplComponents.length).toBe(2);
    for (const c of lgplComponents) {
      expect(c.licenseText).toContain("GENERAL PUBLIC LICENSE");
      expect(c.licenseText).toContain("This library is free software");
    }
  });

  test("each says the source offer is NOT discharged, in those words", () => {
    // The defect this slice was sent to fix was the opposite claim: the
    // generated document asserted brigadier "offers the Library's source,
    // pinned to the exact WebKit and tinycc revisions", and nothing in the
    // repository or the binary backed it. An accurate statement of an
    // undischarged obligation is honest; an inaccurate statement that it is
    // discharged is not.
    for (const c of lgplComponents) {
      expect(c.licenseText).toContain("NOT YET DISCHARGED");
      expect(c.licenseText).toContain("NOT PROVEN");
    }
  });

  test("none of them claims the rebuild path has been shown to reproduce the binary", () => {
    for (const c of lgplComponents) {
      expect(c.licenseText).not.toMatch(/reproduces this binary\b(?!\.)/);
      expect(c.licenseText).toContain("nobody has yet demonstrated");
    }
  });

  test("each carries its own pin, on a line a reader can find it on", () => {
    for (const c of lgplComponents) {
      expect(c.version).toContain(pins()[c.name] as string);
    }
  });
});
