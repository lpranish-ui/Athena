// Listen mode — reads the current chapter aloud with expo-speech.
// Follows along in the list via onActiveIndex, advances chapters via onChapterEnd.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Speech from 'expo-speech';

const RATES = [0.75, 1, 1.25, 1.5, 2] as const;

export interface ListenPalette {
  chrome: string;
  text: string;
  muted: string;
  border: string;
}

export function ListenBar({
  paragraphs,
  startIndex,
  chapterKey,
  title,
  palette,
  onActiveIndex,
  onChapterEnd,
  onClose,
}: {
  paragraphs: string[];
  startIndex: number;
  chapterKey: string;
  title: string;
  palette: ListenPalette;
  onActiveIndex: (index: number) => void;
  onChapterEnd: () => void;
  onClose: () => void;
}) {
  const [playing, setPlaying] = useState(false);
  const [activeIndex, setActiveIndex] = useState(() =>
    Math.min(Math.max(0, startIndex), Math.max(0, paragraphs.length - 1)),
  );
  const [rate, setRate] = useState<number>(1);

  const sessionRef = useRef(0);
  const playingRef = useRef(false);
  const activeIndexRef = useRef(activeIndex);
  const rateRef = useRef(1);
  const paragraphsRef = useRef(paragraphs);
  const onActiveIndexRef = useRef(onActiveIndex);
  const onChapterEndRef = useRef(onChapterEnd);
  const previousChapterRef = useRef(chapterKey);
  const pendingChapterRestartRef = useRef(false);

  // Keep the latest values reachable from speech callbacks without
  // reassigning refs during render.
  useEffect(() => {
    paragraphsRef.current = paragraphs;
  }, [paragraphs]);

  useEffect(() => {
    onActiveIndexRef.current = onActiveIndex;
  }, [onActiveIndex]);

  useEffect(() => {
    onChapterEndRef.current = onChapterEnd;
  }, [onChapterEnd]);

  const stopSpeech = useCallback(() => {
    sessionRef.current += 1;
    void Speech.stop();
  }, []);

  const speak = useCallback(function speakAt(index: number) {
    const text = paragraphsRef.current[index];
    if (!text) return;
    const session = ++sessionRef.current;
    activeIndexRef.current = index;
    setActiveIndex(index);
    onActiveIndexRef.current(index);
    void Speech.stop().then(() => {
      if (session !== sessionRef.current) return;
      Speech.speak(text, {
        rate: rateRef.current,
        onDone: () => {
          if (session !== sessionRef.current) return;
          if (index + 1 < paragraphsRef.current.length) speakAt(index + 1);
          else onChapterEndRef.current();
        },
        onError: () => {
          if (session !== sessionRef.current) return;
          playingRef.current = false;
          setPlaying(false);
        },
      });
    });
  }, []);

  const pause = useCallback(() => {
    playingRef.current = false;
    setPlaying(false);
    stopSpeech();
  }, [stopSpeech]);

  const play = useCallback(() => {
    playingRef.current = true;
    setPlaying(true);
    speak(activeIndexRef.current);
  }, [speak]);

  const moveBy = useCallback((delta: number) => {
    const next = Math.min(
      Math.max(0, activeIndexRef.current + delta),
      Math.max(0, paragraphsRef.current.length - 1),
    );
    if (playingRef.current) {
      speak(next);
    } else {
      activeIndexRef.current = next;
      setActiveIndex(next);
      onActiveIndexRef.current(next);
    }
  }, [speak]);

  const cycleRate = useCallback(() => {
    const current = RATES.indexOf(rateRef.current as (typeof RATES)[number]);
    const next = RATES[(current + 1) % RATES.length] ?? 1;
    rateRef.current = next;
    setRate(next);
    if (playingRef.current) speak(activeIndexRef.current);
  }, [speak]);

  // Chapter switches (manual or auto-advance) restart from the top once the
  // new chapter's paragraphs are loaded.
  useEffect(() => {
    if (previousChapterRef.current !== chapterKey) {
      previousChapterRef.current = chapterKey;
      stopSpeech();
      activeIndexRef.current = 0;
      setActiveIndex(0);
      pendingChapterRestartRef.current = playingRef.current;
    }
    if (pendingChapterRestartRef.current && paragraphs.length > 0) {
      pendingChapterRestartRef.current = false;
      speak(0);
    }
  }, [chapterKey, paragraphs, speak, stopSpeech]);

  // Stop speech when the bar unmounts (close button, navigation).
  useEffect(() => () => {
    sessionRef.current += 1;
    void Speech.stop();
  }, []);

  const rateLabel = rate === 1 ? '1x' : `${rate}x`;

  return (
    <View
      style={[
        styles.bar,
        { backgroundColor: palette.chrome, borderColor: palette.border },
      ]}
    >
      <View style={styles.headerRow}>
        <Text style={[styles.headerLabel, { color: palette.muted }]} numberOfLines={1}>
          Listening · {title} · paragraph {Math.min(activeIndex + 1, paragraphs.length)} of {paragraphs.length}
        </Text>
        <Pressable onPress={onClose} accessibilityLabel="Close listen mode" hitSlop={8}>
          <Text style={{ color: palette.muted, fontSize: 16, fontWeight: '700' }}>✕</Text>
        </Pressable>
      </View>
      <View style={styles.controlsRow}>
        <Pressable
          style={[styles.sideButton, { borderColor: palette.border }]}
          onPress={() => moveBy(-1)}
          accessibilityLabel="Previous paragraph"
        >
          <Ionicons name="play-skip-back" size={18} color={palette.text} />
        </Pressable>
        <Pressable
          style={[styles.playButton, playing ? styles.playButtonActive : null]}
          onPress={() => (playing ? pause() : play())}
          accessibilityLabel={playing ? 'Pause listening' : 'Start listening'}
        >
          <Ionicons name={playing ? 'pause' : 'play'} size={24} color="#04241F" />
        </Pressable>
        <Pressable
          style={[styles.sideButton, { borderColor: palette.border }]}
          onPress={() => moveBy(1)}
          accessibilityLabel="Next paragraph"
        >
          <Ionicons name="play-skip-forward" size={18} color={palette.text} />
        </Pressable>
        <Pressable
          style={[styles.rateChip, { borderColor: palette.border }]}
          onPress={cycleRate}
          accessibilityLabel="Change reading speed"
        >
          <Text style={{ color: palette.text, fontWeight: '700', fontSize: 13 }}>{rateLabel}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 12,
    gap: 8,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  headerLabel: {
    fontSize: 12,
    flexShrink: 1,
  },
  controlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
  },
  sideButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playButton: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: '#2DD4BF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  playButtonActive: {
    backgroundColor: '#5EEAD4',
  },
  rateChip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
});
