import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import { useState } from 'react';
import {
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    View,
} from 'react-native';

import { Screen } from '@/components/Screen';
import { Button, Card, ErrorBanner, Input } from '@/components/ui';
import { ingestBook } from '@/lib/api';
import { pickBookFile, uploadBookFile, waitForBookReady, type PickedBookFile } from '@/lib/files';
import { suggestSubject } from '@/lib/subjects';
import { colors, fontSize, radius, spacing, SUBJECT_SUGGESTIONS, withAlpha } from '@/theme';

type Mode = 'file' | 'text';

export default function UploadScreen() {
  const router = useRouter();

  const [mode, setMode] = useState<Mode>('file');
  const [picked, setPicked] = useState<PickedBookFile | null>(null);
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [subject, setSubject] = useState('General');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [rights, setRights] = useState(false);

  const reset = (nextMode?: Mode) => {
    setError(null);
    if (nextMode) setMode(nextMode);
  };

  const chooseFile = async () => {
    setError(null);
    try {
      const file = await pickBookFile();
      if (!file) return;
      setPicked(file);
      if (!title.trim()) {
        const suggested = file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
        setTitle(suggested);
        if (subject === 'General') {
          const guess = suggestSubject(suggested);
          if (guess) setSubject(guess);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open the file picker.');
    }
  };

  const startFileUpload = async () => {
    if (!rights) {
      setError('Please confirm you have the right to use this book first.');
      return;
    }
    if (!picked) {
      setError('Choose a file first.');
      return;
    }
    if (!title.trim()) {
      setError('Give the book a title.');
      return;
    }

    setBusy(true);
    setError(null);
    setProgress(0);
    setStage('Preparing upload…');
    try {
      // Send bounded chunks; the server validates file and extracted-text limits.
      const { bookId } = await uploadBookFile(picked, {
        title: title.trim(),
        subject: subject.trim() || 'General',
        author: author.trim() || undefined,
        onProgress: (update) => {
          if (update.phase === 'uploading') {
            const ratio = update.totalBytes > 0 ? update.sentBytes / update.totalBytes : 0;
            setProgress(ratio);
            setStage(`Uploading… ${Math.round(ratio * 100)}%`);
          } else {
            setStage('Reading your book — large books can take several minutes…');
          }
        },
      });

      await waitForBookReady(bookId, { onNote: (note) => setStage(note) });
      router.replace({ pathname: '/book/[id]', params: { id: bookId } });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed. Please try again.');
    } finally {
      setBusy(false);
      setStage(null);
      setProgress(0);
    }
  };

  const startTextImport = async () => {
    if (!rights) {
      setError('Please confirm you have the right to use this book first.');
      return;
    }
    if (!title.trim()) {
      setError('Give the book a title.');
      return;
    }
    if (text.trim().length < 100) {
      setError('Paste at least a few paragraphs of text.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      setStage('Building book and chapters…');
      const result = await ingestBook({
        title: title.trim(),
        subject: subject.trim() || 'General',
        author: author.trim() || undefined,
        text,
      });
      router.replace({ pathname: '/book/[id]', params: { id: result.bookId } });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed. Please try again.');
    } finally {
      setBusy(false);
      setStage(null);
    }
  };

  const sizeLabel = picked?.size
    ? `${(picked.size / (1024 * 1024)).toFixed(1)} MB`
    : '—';

  return (
    <Screen padded={false}>
      <Stack.Screen options={{ title: 'Add a book' }} />
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.modeRow}>
          <Pressable
            disabled={busy}
            onPress={() => reset('file')}
            style={[styles.modeButton, mode === 'file' && styles.modeActive]}
          >
            <Text style={[styles.modeText, mode === 'file' && styles.modeTextActive]}>
              Upload file
            </Text>
          </Pressable>
          <Pressable
            disabled={busy}
            onPress={() => reset('text')}
            style={[styles.modeButton, mode === 'text' && styles.modeActive]}
          >
            <Text style={[styles.modeText, mode === 'text' && styles.modeTextActive]}>
              Paste text
            </Text>
          </Pressable>
        </View>

        {error ? <ErrorBanner message={error} /> : null}

        {mode === 'file' ? (
          <Card style={styles.card}>
            <Text style={styles.cardTitle}>Choose your PDF, EPUB or TXT</Text>
            <Button
              label={picked ? 'Choose a different file' : 'Choose file'}
              variant="secondary"
              icon="document-outline"
              onPress={() => void chooseFile()}
              disabled={busy}
            />
            {picked ? (
              <View style={styles.fileInfo}>
                <Text style={styles.fileName} numberOfLines={1}>
                  {picked.name}
                </Text>
                <Text style={styles.fileMeta}>
                  {picked.fileType.toUpperCase()} · {sizeLabel}
                </Text>
              </View>
            ) : null}
          </Card>
        ) : (
          <Card style={styles.card}>
            <Text style={styles.cardTitle}>Paste the chapter text</Text>
            <Input
              value={text}
              onChangeText={setText}
              placeholder="Paste your notes or chapter text here…"
              multiline
              editable={!busy}
              style={styles.textArea}
            />
          </Card>
        )}

        <Card style={styles.card}>
          <Text style={styles.cardTitle}>Book details</Text>
          <Input
            label="Title"
            value={title}
            onChangeText={setTitle}
            placeholder="e.g. Clinical Microbiology"
            editable={!busy}
            onEndEditing={() => {
              if (subject === 'General') {
                const guess = suggestSubject(title);
                if (guess) setSubject(guess);
              }
            }}
          />
          <Input
            label="Author (optional)"
            value={author}
            onChangeText={setAuthor}
            placeholder="e.g. Dr. A. Kumar"
            editable={!busy}
          />
          <Input
            label="Subject"
            value={subject}
            onChangeText={setSubject}
            placeholder="e.g. Microbiology"
            editable={!busy}
          />
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.chipRow}
          >
            {SUBJECT_SUGGESTIONS.map((suggestion) => {
              const active = subject === suggestion;
              return (
                <Pressable
                  key={suggestion}
                  disabled={busy}
                  onPress={() => setSubject(suggestion)}
                  style={[styles.chip, active && styles.chipActive]}
                >
                  <Text style={[styles.chipText, active && styles.chipTextActive]}>
                    {suggestion}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </Card>

        <Pressable
          disabled={busy}
          onPress={() => setRights((value) => !value)}
          style={styles.rightsRow}
        >
          <View style={[styles.checkbox, rights && styles.checkboxOn]}>
            {rights ? <Ionicons name="checkmark" size={14} color={colors.primaryText} /> : null}
          </View>
          <Text style={styles.rightsText}>
            I confirm I have the right to use this book for my personal study.
          </Text>
        </Pressable>

        <Button
          label={mode === 'file' ? 'Upload & build chapters' : 'Create book from text'}
          icon="cloud-upload-outline"
          onPress={() => (mode === 'file' ? void startFileUpload() : void startTextImport())}
          loading={busy}
          disabled={!rights}
        />
        {stage ? <Text style={styles.stage}>{stage}</Text> : null}
        {busy && progress > 0 ? (
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${Math.round(progress * 100)}%` }]} />
          </View>
        ) : null}

        <Card style={styles.tips} padded>
          <Text style={styles.tipsTitle}>Good to know</Text>
          <Text style={styles.tip}>• Files up to 512 MB are supported by default; uploads use small chunks.</Text>
          <Text style={styles.tip}>• PDFs must have selectable text — scans are not supported yet.</Text>
          <Text style={styles.tip}>• Chapters are detected from “Chapter N” style headings; otherwise the text is split into parts.</Text>
          <Text style={styles.tip}>• Your uploads stay private to your account.</Text>
          <Text style={styles.tip}>• Duplicate uploads of the same file are detected automatically.</Text>
          <Text style={styles.tip}>• Big books (500+ pages) can take several minutes to process.</Text>
        </Card>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: 20,
    paddingBottom: 48,
    gap: spacing.md,
    maxWidth: 620,
    width: '100%',
    alignSelf: 'center',
  },
  modeRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  modeButton: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 11,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
  },
  modeActive: {
    borderColor: colors.primary,
    backgroundColor: withAlpha(colors.primary, '1F'),
  },
  modeText: {
    color: colors.textMuted,
    fontWeight: '700',
    fontSize: fontSize.sm,
  },
  modeTextActive: {
    color: colors.primary,
  },
  card: {
    gap: spacing.md,
  },
  cardTitle: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: '700',
  },
  fileInfo: {
    gap: 2,
  },
  fileName: {
    color: colors.text,
    fontSize: fontSize.sm,
    fontWeight: '600',
  },
  fileMeta: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
  },
  textArea: {
    minHeight: 220,
  },
  chipRow: {
    gap: spacing.sm,
    paddingRight: spacing.md,
  },
  chip: {
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  chipActive: {
    borderColor: colors.primary,
    backgroundColor: withAlpha(colors.primary, '1F'),
  },
  chipText: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
    fontWeight: '600',
  },
  chipTextActive: {
    color: colors.primary,
    fontWeight: '800',
  },
  stage: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    textAlign: 'center',
  },
  progressTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.surfaceAlt,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 3,
    backgroundColor: colors.primary,
  },
  rightsRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  checkboxOn: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  rightsText: {
    flex: 1,
    color: colors.textMuted,
    fontSize: fontSize.sm,
    lineHeight: 20,
  },
  tips: {
    gap: spacing.sm,
    borderColor: withAlpha(colors.accent, '33'),
  },
  tipsTitle: {
    color: colors.text,
    fontWeight: '700',
    fontSize: fontSize.sm,
  },
  tip: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
    lineHeight: 18,
  },
});
