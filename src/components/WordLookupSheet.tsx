// Tap-a-word dictionary sheet for the reader (opened from the passage actions).
// The reader remounts this by key so each paragraph starts with a clean state.
import { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { defineWord, normalizeWord, type WordDefinition } from '@/lib/lookup';

export interface LookupPalette {
  chrome: string;
  text: string;
  muted: string;
  border: string;
}

interface LookupState {
  token: string;
  loading: boolean;
  definition: WordDefinition | null;
  failed: boolean;
}

export function WordLookupSheet({
  text,
  palette,
  onClose,
}: {
  text: string | null;
  palette: LookupPalette;
  onClose: () => void;
}) {
  const [lookup, setLookup] = useState<LookupState | null>(null);
  const seqRef = useRef(0);

  const tokens = useMemo(() => (text ? text.split(/\s+/) : []), [text]);

  const onWordPress = useCallback((token: string) => {
    const query = normalizeWord(token);
    if (query.length < 2) return;
    const seq = ++seqRef.current;
    setLookup({ token, loading: true, definition: null, failed: false });
    void defineWord(query).then((definition) => {
      if (seq !== seqRef.current) return;
      setLookup({ token, loading: false, definition, failed: definition === null });
    });
  }, []);

  return (
    <Modal visible={text !== null} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={[styles.sheet, { backgroundColor: palette.chrome, borderColor: palette.border }]}>
        <View style={styles.headerRow}>
          <Text style={[styles.title, { color: palette.text }]}>Word lookup</Text>
          <Pressable onPress={onClose} accessibilityLabel="Close word lookup">
            <Text style={{ color: palette.muted, fontSize: 18, fontWeight: '700' }}>✕</Text>
          </Pressable>
        </View>
        <Text style={[styles.hint, { color: palette.muted }]}>
          Tap any word in the passage to see its definition.
        </Text>

        <ScrollView style={[styles.passageBox, { borderColor: palette.border }]} contentContainerStyle={styles.passageContent}>
          <Text style={{ lineHeight: 26 }}>
            {tokens.map((token, tokenIndex) => {
              const isWord = normalizeWord(token).length > 1;
              const selected = lookup?.token === token && isWord;
              return (
                <Text
                  key={`${tokenIndex}-${token}`}
                  onPress={isWord ? () => onWordPress(token) : undefined}
                  style={{
                    color: selected ? '#2DD4BF' : palette.text,
                    fontSize: 16,
                    textDecorationLine: selected ? 'underline' : 'none',
                  }}
                >
                  {token}
                  {tokenIndex < tokens.length - 1 ? ' ' : ''}
                </Text>
              );
            })}
          </Text>
        </ScrollView>

        {lookup ? (
          lookup.loading ? (
            <View style={styles.resultRow}>
              <ActivityIndicator color={palette.muted} />
              <Text style={{ color: palette.muted }}>Looking up “{normalizeWord(lookup.token)}”…</Text>
            </View>
          ) : lookup.failed ? (
            <View style={[styles.resultCard, { borderColor: palette.border }]}>
              <Text style={{ color: palette.muted }}>
                No definition found for “{normalizeWord(lookup.token)}”.
              </Text>
            </View>
          ) : lookup.definition ? (
            <View style={[styles.resultCard, { borderColor: palette.border }]}>
              <View style={styles.wordRow}>
                <Text style={{ color: palette.text, fontSize: 18, fontWeight: '800' }}>
                  {lookup.definition.word}
                </Text>
                {lookup.definition.phonetic ? (
                  <Text style={{ color: palette.muted, fontSize: 13 }}>
                    {lookup.definition.phonetic}
                  </Text>
                ) : null}
              </View>
              {lookup.definition.meanings.map((meaning, meaningIndex) => (
                <View key={meaningIndex} style={styles.meaningRow}>
                  {meaning.partOfSpeech ? (
                    <Text style={styles.partOfSpeech}>{meaning.partOfSpeech}</Text>
                  ) : null}
                  <Text style={{ color: palette.text, lineHeight: 21 }}>
                    {meaningIndex + 1}. {meaning.definition}
                  </Text>
                  {meaning.example ? (
                    <Text style={{ color: palette.muted, fontStyle: 'italic', marginTop: 2 }}>
                      e.g. {meaning.example}
                    </Text>
                  ) : null}
                </View>
              ))}
            </View>
          ) : null
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(4, 8, 15, 0.55)',
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 26,
    gap: 10,
    maxHeight: '78%',
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    fontSize: 17,
    fontWeight: '800',
  },
  hint: {
    fontSize: 12,
  },
  passageBox: {
    borderWidth: 1,
    borderRadius: 12,
    maxHeight: 220,
  },
  passageContent: {
    padding: 12,
  },
  resultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 6,
  },
  resultCard: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    gap: 8,
  },
  wordRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 8,
  },
  meaningRow: {
    gap: 2,
  },
  partOfSpeech: {
    color: '#38BDF8',
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
});
