// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NO_VOCABULARY, VOCABULARY_MIN_MESSAGES, vocabularyFromCounts, vocabularyFromMessages, wordKey } from "./person-vocabulary.js";
import { personVocabularyPath, readPersonVocabulary, recordPersonVocabulary } from "./person-vocabulary-store.js";

const NOW = "2026-10-01T12:00:00.000Z";
const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map((h) => rm(h, { recursive: true, force: true }))); });

/** The same eight requests in four languages: each language's function words are learned alike. */
const WRITERS: Record<string, { messages: string[]; functionWords: string[]; topicWord: string }> = {
  English: {
    messages: ["fix the login page for me", "check the logs for the build", "move the helpers to the new file", "keep the README short for now",
      "look at the cache and the tests", "split the module for the feature", "rename the button on the page", "update the docs for the API"],
    functionWords: ["the", "for"], topicWord: "login",
  },
  Turkish: {
    messages: ["bu sayfayı bir düzelt", "bu hata için bir log ekle", "yardımcıları bir dosyaya taşı ve bitir", "README için bir özet yaz",
      "bu önbelleği ve testleri kontrol et", "bu modülü bir böl", "bu butonun adını bir değiştir", "API için bir doküman yaz ve bitir"],
    functionWords: ["bir", "bu"], topicWord: "onbellegi",
  },
  German: {
    messages: ["prüf die Seite und den Header", "schau dir die Logs und den Build an", "verschieb die Helfer in die Datei", "halte die README kurz und knapp",
      "prüf den Cache und die Tests", "teil das Modul und die Funktion", "benenne die Schaltfläche um", "aktualisiere die Doku und die API"],
    functionWords: ["die", "und"], topicWord: "header",
  },
  French: {
    messages: ["corrige la page de connexion", "regarde les logs de la compilation", "déplace les helpers dans le fichier", "garde le README court",
      "vérifie le cache et les tests", "découpe le module de la fonction", "renomme le bouton de la page", "mets à jour la doc de l'API"],
    functionWords: ["les", "de" /* under three letters: never a term anyway */], topicWord: "connexion",
  },
};

describe("learning which words carry no topic, without a list in any language", () => {
  for (const [language, w] of Object.entries(WRITERS)) {
    it(`${language}: frequent function words are learned, a topic word is not`, () => {
      const vocab = vocabularyFromMessages(w.messages);
      expect(vocab.learned).toBe(true);
      for (const fn of w.functionWords.filter((x) => x.length >= 3)) expect(vocab.isStop(fn)).toBe(true);
      expect(vocab.isStop(w.topicWord)).toBe(false);
    });
  }

  it("knows nothing before enough messages, and says so", () => {
    expect(vocabularyFromMessages(WRITERS.English!.messages.slice(0, VOCABULARY_MIN_MESSAGES - 1)).learned).toBe(false);
    expect(vocabularyFromCounts(null)).toBe(NO_VOCABULARY);
  });

  it("counts a pasted or repeated message once", () => {
    const same = Array.from({ length: 12 }, () => "the very same message about the login page");
    expect(vocabularyFromMessages(same).learned).toBe(false);
  });
});

describe("the store keeps counts, never words", () => {
  it("records hashed keys only, and reads back the same vocabulary", async () => {
    const home = await mkdtemp(join(tmpdir(), "pr-vocab-"));
    homes.push(home);
    const env = { PATHRULE_HOME: home } as NodeJS.ProcessEnv;
    const messages = [...WRITERS.Turkish!.messages, "gizli-proje-adi ile ilgili bir not"];
    await recordPersonVocabulary("local", messages.slice(0, 4), { now: NOW, env });
    await recordPersonVocabulary("local", messages.slice(4), { now: NOW, env });

    const raw = await readFile(personVocabularyPath("local", env), "utf8");
    for (const word of ["sayfayi", "bir", "gizli", "proje"]) expect(raw).not.toContain(word);
    expect(raw).toContain(wordKey("bir"));

    const counts = await readPersonVocabulary("local", env);
    expect(counts?.messages).toBe(messages.length);
    const vocab = vocabularyFromCounts(counts);
    expect(vocab.isStop("bir")).toBe(true);
    expect(vocab.isStop("onbellegi")).toBe(false);
  });

  it("an unreadable file means nothing learned, never an error", async () => {
    const home = await mkdtemp(join(tmpdir(), "pr-vocab-"));
    homes.push(home);
    expect(await readPersonVocabulary("local", { PATHRULE_HOME: home } as NodeJS.ProcessEnv)).toBeNull();
  });
});
