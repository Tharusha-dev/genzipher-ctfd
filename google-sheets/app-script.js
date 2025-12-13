const SHEET_SETTINGS = "Settings";
const SHEET_CLUES = "Clues";
const SHEET_TEAM = "TeamProgress";
const SHEET_MEMBER = "MemberProgress";
const SHEET_SOLVES = "SolveLog";

function setupSheets() {
  const ss = SpreadsheetApp.getActive();

  ensureSheet_(ss, SHEET_SETTINGS, ["key","value"]);
  ensureSheet_(ss, SHEET_CLUES, ["clue_no","threshold_solves","title","clue_text","email_subject","email_body"]);
  ensureSheet_(ss, SHEET_TEAM, ["team_id","team_name","solve_count","last_clue_sent","last_solve_at","members_emails"]);
  ensureSheet_(ss, SHEET_MEMBER, ["user_id","user_name","email","team_id","team_name","solve_count","last_solve_at"]);
  ensureSheet_(ss, SHEET_SOLVES, ["timestamp","solve_id","team_id","team_name","user_id","user_name","challenge_id","challenge_name","team_solve_count"]);

  SpreadsheetApp.getUi().alert("Sheets ensured. Now fill Settings + Clues.");
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const body = JSON.parse(e.postData.contents || "{}");
    const secret = (e.parameter && e.parameter.secret) ? e.parameter.secret : "";
    const headerSecret = (e.postData && e.postData.type) ? "" : ""; // headers not directly available in doPost
    // We'll validate using JSON body "secret" OR URL param "secret" for simplicity.
    // Recommended: plugin sends body.secret.

    const settings = getSettings_();
    if (String(settings.enabled).toUpperCase() !== "TRUE") {
      return json_(200, { ok: true, skipped: "disabled" });
    }

    const expectedSecret = String(settings.shared_secret || "");
    if (!expectedSecret) return json_(500, { ok: false, error: "Missing Settings.shared_secret" });

    if (String(body.secret || secret) !== expectedSecret) {
      return json_(401, { ok: false, error: "Unauthorized (bad secret)" });
    }

    if (body.event !== "solve") {
      return json_(400, { ok: false, error: "Unsupported event" });
    }

    // Required fields
    const solveId = Number(body.solve_id);
    const teamId = String(body.team?.id ?? "");
    const teamName = String(body.team?.name ?? "");
    const userId = String(body.user?.id ?? "");
    const userName = String(body.user?.name ?? "");
    const userEmail = String(body.user?.email ?? "");
    const chalId = String(body.challenge?.id ?? "");
    const chalName = String(body.challenge?.name ?? "");
    const teamSolveCount = Number(body.team_solve_count);

    if (!solveId || !teamId) return json_(400, { ok: false, error: "Missing solve_id/team.id" });

    // Dedupe by solve_id (fast enough for typical CTF sizes)
    if (isSolveProcessed_(solveId)) {
      return json_(200, { ok: true, deduped: true });
    }

    // Append SolveLog
    appendSolveLog_(new Date(), solveId, teamId, teamName, userId, userName, chalId, chalName, teamSolveCount);

    // Update TeamProgress
    const members = Array.isArray(body.team_members) ? body.team_members : [];
    const memberEmails = members.map(m => m.email).filter(Boolean).join(", ");
    const teamRow = upsertTeam_(teamId, teamName, teamSolveCount, new Date(), memberEmails);

    // Update MemberProgress (count per member)
    upsertMemberSolve_(userId, userName, userEmail, teamId, teamName, new Date());

    // Evaluate clues (send any newly unlocked clues IN ORDER)
    const clues = getClues_(); // sorted by clue_no asc
    const lastClueSent = Number(teamRow.last_clue_sent || 0);

    let sentUpTo = lastClueSent;
    for (const clue of clues) {
      const clueNo = Number(clue.clue_no);
      const threshold = Number(clue.threshold_solves);

      if (clueNo <= sentUpTo) continue;
      if (teamSolveCount >= threshold) {
        // Send clue email
        const subject = renderTemplate_(clue.email_subject || `Clue ${clueNo} unlocked!`, {
          team_name: teamName,
          clue_text: clue.clue_text
        });

        const prefix = String(settings.email_subject_prefix || "").trim();
        const finalSubject = prefix ? `${prefix} ${subject}` : subject;

        const bodyText = renderTemplate_(clue.email_body || `Hi {{team_name}},\n\n{{clue_text}}`, {
          team_name: teamName,
          clue_text: clue.clue_text
        });

        // recipients: all team members (fallback: user)
        const recipients = members.map(m => m.email).filter(Boolean);
        if (recipients.length === 0 && userEmail) recipients.push(userEmail);

        if (recipients.length > 0) {
          MailApp.sendEmail({
            to: recipients.join(","),
            subject: finalSubject,
            body: bodyText,
            name: String(settings.email_from_name || "CTF Hints Bot")
          });
        }

        sentUpTo = clueNo;
      }
    }

    if (sentUpTo !== lastClueSent) {
      updateTeamLastClueSent_(teamId, sentUpTo);
    }

    return json_(200, { ok: true, team_id: teamId, solve_count: teamSolveCount, last_clue_sent: sentUpTo });
  } catch (err) {
    return json_(500, { ok: false, error: String(err && err.stack ? err.stack : err) });
  } finally {
    lock.releaseLock();
  }
}

/* ---------------- helpers ---------------- */

function ensureSheet_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  const firstRow = sh.getRange(1, 1, 1, headers.length).getValues()[0];
  const needsHeader = headers.some((h, i) => String(firstRow[i] || "").trim() !== h);
  if (needsHeader) {
    sh.clear();
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.setFrozenRows(1);
  }
}

function getSettings_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_SETTINGS);
  const values = sh.getDataRange().getValues();
  const out = {};
  for (let i = 1; i < values.length; i++) {
    const k = String(values[i][0] || "").trim();
    const v = values[i][1];
    if (k) out[k] = v;
  }
  return out;
}

function getClues_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_CLUES);
  const values = sh.getDataRange().getValues();
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const clueNo = values[i][0];
    if (clueNo === "" || clueNo === null) continue;
    rows.push({
      clue_no: Number(values[i][0]),
      threshold_solves: Number(values[i][1]),
      title: String(values[i][2] || ""),
      clue_text: String(values[i][3] || ""),
      email_subject: String(values[i][4] || ""),
      email_body: String(values[i][5] || "")
    });
  }
  rows.sort((a,b) => a.clue_no - b.clue_no);
  return rows;
}

function isSolveProcessed_(solveId) {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_SOLVES);
  const finder = sh.createTextFinder(String(solveId));
  finder.matchCase(false);
  finder.useRegularExpression(false);
  // Search in column B (solve_id)
  const colB = sh.getRange(2, 2, Math.max(sh.getLastRow() - 1, 1), 1);
  const found = colB.createTextFinder(String(solveId)).findNext();
  return !!found;
}

function appendSolveLog_(ts, solveId, teamId, teamName, userId, userName, chalId, chalName, teamSolveCount) {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_SOLVES);
  sh.appendRow([ts, solveId, teamId, teamName, userId, userName, chalId, chalName, teamSolveCount]);
}

function upsertTeam_(teamId, teamName, solveCount, lastSolveAt, memberEmails) {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_TEAM);
  const values = sh.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]) === String(teamId)) {
      // update row
      sh.getRange(i+1, 2).setValue(teamName);
      sh.getRange(i+1, 3).setValue(solveCount);
      sh.getRange(i+1, 5).setValue(lastSolveAt);
      if (memberEmails) sh.getRange(i+1, 6).setValue(memberEmails);
      return {
        team_id: teamId,
        last_clue_sent: values[i][3]
      };
    }
  }
  // insert new
  sh.appendRow([teamId, teamName, solveCount, 0, lastSolveAt, memberEmails || ""]);
  return { team_id: teamId, last_clue_sent: 0 };
}

function updateTeamLastClueSent_(teamId, lastClueSent) {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_TEAM);
  const values = sh.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]) === String(teamId)) {
      sh.getRange(i+1, 4).setValue(lastClueSent);
      return;
    }
  }
}

function upsertMemberSolve_(userId, userName, email, teamId, teamName, lastSolveAt) {
  if (!userId) return;
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_MEMBER);
  const values = sh.getDataRange().getValues();

  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]) === String(userId)) {
      const current = Number(values[i][5] || 0);
      sh.getRange(i+1, 2).setValue(userName);
      sh.getRange(i+1, 3).setValue(email);
      sh.getRange(i+1, 4).setValue(teamId);
      sh.getRange(i+1, 5).setValue(teamName);
      sh.getRange(i+1, 6).setValue(current + 1);
      sh.getRange(i+1, 7).setValue(lastSolveAt);
      return;
    }
  }
  sh.appendRow([userId, userName, email, teamId, teamName, 1, lastSolveAt]);
}

function renderTemplate_(tpl, vars) {
  let out = String(tpl || "");
  Object.keys(vars).forEach(k => {
    const re = new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`, "g");
    out = out.replace(re, String(vars[k] ?? ""));
  });
  return out;
}

function json_(code, obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
