import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';
import * as ImageManipulator from 'expo-image-manipulator';
import * as Location from 'expo-location';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';

const API_URL = (process.env.EXPO_PUBLIC_API_URL || 'http://10.0.2.2:8000').replace(/\/$/, '');
const TOKEN_KEY = 'parallel-lives-token';

type User = {
  id: string;
  phone_number: string;
  anonymous_handle: string;
  neighborhood_tag: string;
  latitude: number | null;
  longitude: number | null;
};

type Asset = {
  id: string;
  author_id: string;
  asset_type: string;
  content: string | null;
  media_url: string | null;
  created_at: string;
};

type Room = {
  room_id: string;
  room_level: number;
  day_streak: number;
  days_until_unmask: number;
  unmask_day_threshold: number;
  shared_state: { plant_health: number; active_track: string | null; theme: string };
  assets: Asset[];
  partner: { anonymous_handle: string; neighborhood_tag: string; verification_tier: string } | null;
  demo_companion: boolean;
  is_unmasked: boolean;
  friendship_id: string | null;
  my_unmask_vote: number | null;
};

type Message = { id: string; author_id: string; content: string; created_at: string };
type Friendship = { friendship_id: string; anonymous_handle: string; neighborhood_tag: string; verification_tier: string };

async function request<T>(path: string, token?: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = Array.isArray(result.detail)
      ? result.detail.map((item: { msg?: string }) => item.msg || 'Invalid input').join('. ')
      : result.detail;
    throw new Error(detail || `Request failed (${response.status})`);
  }
  return result as T;
}

function Button({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'quiet' | 'danger';
  disabled?: boolean;
}) {
  return (
    <TouchableOpacity
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={[styles.button, styles[`button_${variant}`], disabled && styles.buttonDisabled]}
    >
      <Text style={[styles.buttonText, styles[`buttonText_${variant}`]]}>{label}</Text>
    </TouchableOpacity>
  );
}

function Field(props: React.ComponentProps<typeof TextInput>) {
  return (
    <TextInput
      placeholderTextColor="#77839a"
      style={styles.input}
      {...props}
    />
  );
}

export default function App() {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [phone, setPhone] = useState('+91');
  const [otp, setOtp] = useState('');
  const [otpRequested, setOtpRequested] = useState(false);
  const [handle, setHandle] = useState('');
  const [neighborhood, setNeighborhood] = useState('Baner');
  const [latitude, setLatitude] = useState('');
  const [longitude, setLongitude] = useState('');
  const [vibes, setVibes] = useState('music, coffee, slow-life');
  const [room, setRoom] = useState<Room | null>(null);
  const [tab, setTab] = useState<'room' | 'circle' | 'profile'>('room');
  const [note, setNote] = useState('');
  const [photoUri, setPhotoUri] = useState('');
  const [photoBase64, setPhotoBase64] = useState('');
  const [photoType, setPhotoType] = useState('image/jpeg');
  const [track, setTrack] = useState('');
  const [friendships, setFriendships] = useState<Friendship[]>([]);
  const [selectedFriendship, setSelectedFriendship] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [messageText, setMessageText] = useState('');
  const socket = useRef<WebSocket | null>(null);

  const reportError = useCallback((reason: unknown) => {
    setError(reason instanceof Error ? reason.message : 'Something went wrong. Please try again.');
  }, []);

  const loadRoom = useCallback(async (accessToken: string) => {
    try {
      const data = await request<Room>('/api/v1/room/active', accessToken);
      setRoom(data);
      setError('');
    } catch (reason) {
      if (reason instanceof Error && reason.message.includes('active room')) {
        setRoom(null);
        return;
      }
      throw reason;
    }
  }, []);

  const loadCircle = useCallback(async (accessToken: string) => {
    const result = await request<{ friendships: Friendship[] }>('/api/v1/circles', accessToken);
    setFriendships(result.friendships);
  }, []);

  const refreshSession = useCallback(async (accessToken: string) => {
    const result = await request<{ user: User; profile_complete: boolean }>('/api/v1/me', accessToken);
    setUser(result.user);
    if (result.profile_complete) {
      await loadRoom(accessToken);
      await loadCircle(accessToken);
    }
  }, [loadCircle, loadRoom]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const savedToken = await AsyncStorage.getItem(TOKEN_KEY);
        if (savedToken) {
          await refreshSession(savedToken);
          if (mounted) setToken(savedToken);
        }
      } catch (reason) {
        await AsyncStorage.removeItem(TOKEN_KEY);
        if (mounted) reportError(reason);
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => {
      mounted = false;
      socket.current?.close();
    };
  }, [refreshSession, reportError]);

  useEffect(() => {
    if (!token || !room?.room_id) return undefined;
    const wsUrl = `${API_URL.replace(/^http/, 'ws')}/ws/room/${room.room_id}?token=${encodeURIComponent(token)}`;
    const connection = new WebSocket(wsUrl);
    socket.current = connection;
    connection.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.event === 'state_sync') {
          setRoom((current) => current ? {
            ...current,
            shared_state: { ...current.shared_state, ...data.payload },
            assets: data.payload.asset
              ? current.assets.some((asset) => asset.id === data.payload.asset.id)
                ? current.assets
                : [...current.assets, data.payload.asset]
              : current.assets,
          } : current);
        } else if (data.event === 'room_dissolved') {
          setRoom(null);
        } else if (data.event === 'haptic_nudge') {
          if (data.payload?.from !== user?.id) {
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            Alert.alert('Coffee bump', 'Your companion sent a little hello.');
          }
        } else if (data.event === 'unmask_updated') {
          if (data.payload?.status === 'graduated') {
            setRoom(null);
            setTab('circle');
            loadCircle(token).catch(reportError);
          } else {
            loadRoom(token).catch(reportError);
          }
        }
      } catch {
        reportError(new Error('Received an invalid live room update.'));
      }
    };
    connection.onerror = () => setError('Live sync is disconnected. Check that the API server is running.');
    return () => {
      connection.close();
      if (socket.current === connection) socket.current = null;
    };
  }, [loadCircle, loadRoom, reportError, room?.room_id, token, user?.id]);

  useEffect(() => {
    if (!token || !selectedFriendship) return undefined;
    let active = true;
    const refreshMessages = async () => {
      try {
        const result = await request<{ messages: Message[] }>(`/api/v1/circles/${selectedFriendship}/messages`, token);
        if (active) setMessages(result.messages);
      } catch (reason) {
        if (active) reportError(reason);
      }
    };
    refreshMessages();
    const timer = setInterval(refreshMessages, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [reportError, selectedFriendship, token]);

  const perform = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (reason) {
      reportError(reason);
    } finally {
      setBusy(false);
    }
  };

  const requestOtp = () => perform(async () => {
    const result = await request<{ demo_code?: string }>('/api/v1/auth/request-otp', undefined, {
      method: 'POST',
      body: JSON.stringify({ phone }),
    });
    setOtpRequested(true);
    if (result.demo_code) setOtp(result.demo_code);
  });

  const verifyOtp = () => perform(async () => {
    const result = await request<{ token: string; user: User }>('/api/v1/auth/verify-otp', undefined, {
      method: 'POST',
      body: JSON.stringify({ phone, code: otp }),
    });
    await AsyncStorage.setItem(TOKEN_KEY, result.token);
    setToken(result.token);
    setUser(result.user);
  });

  const locateMe = () => perform(async () => {
    const permission = await Location.requestForegroundPermissionsAsync();
    if (permission.status !== 'granted') throw new Error('Location permission is required for Pune matching.');
    const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    setLatitude(position.coords.latitude.toFixed(6));
    setLongitude(position.coords.longitude.toFixed(6));
  });

  const saveProfile = () => perform(async () => {
    if (!token) return;
    const result = await request<{ user: User }>('/api/v1/profile', token, {
      method: 'POST',
      body: JSON.stringify({
        handle,
        neighborhood,
        latitude: Number(latitude),
        longitude: Number(longitude),
        vibes: vibes.split(',').map((value) => value.trim()).filter(Boolean),
      }),
    });
    setUser({ ...user!, ...result.user });
    setError('');
  });

  const findCompanion = () => perform(async () => {
    if (!token) return;
    const result = await request<Room>('/api/v1/match/find-companion', token, {
      method: 'POST',
      body: JSON.stringify({
        latitude: Number(latitude || user?.latitude),
        longitude: Number(longitude || user?.longitude),
        vibe_filters: vibes.split(',').map((value) => value.trim()).filter(Boolean),
      }),
    });
    setRoom(result);
    setTab('room');
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  });

  const postAsset = () => perform(async () => {
    if (!token) return;
    const result = await request<{ asset: Asset }>('/api/v1/room/asset', token, {
      method: 'POST',
      body: JSON.stringify({
        asset_type: 'sticky_note',
        content: note.trim(),
      }),
    });
    setRoom((current) => current ? {
      ...current,
      assets: current.assets.some((asset) => asset.id === result.asset.id)
        ? current.assets
        : [...current.assets, result.asset],
    } : current);
    setNote('');
  });

  const choosePhoto = () => perform(async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) throw new Error('Photo library permission is required to choose a polaroid.');
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
    });
    if (result.canceled) return;
    const selected = result.assets[0];
    const prepared = await ImageManipulator.manipulateAsync(
      selected.uri,
      [{ resize: { width: Math.min(1600, selected.width) } }],
      { compress: 0.75, format: ImageManipulator.SaveFormat.JPEG, base64: true },
    );
    if (!prepared.base64) throw new Error('Could not prepare the selected image. Please choose another photo.');
    setPhotoUri(prepared.uri);
    setPhotoBase64(prepared.base64);
    setPhotoType('image/jpeg');
  });

  const uploadPolaroid = () => perform(async () => {
    if (!token || !photoBase64) return;
    const result = await request<{ asset: Asset }>('/api/v1/room/polaroid', token, {
      method: 'POST',
      body: JSON.stringify({ image_base64: photoBase64, content_type: photoType }),
    });
    setRoom((current) => current ? {
      ...current,
      assets: current.assets.some((asset) => asset.id === result.asset.id)
        ? current.assets
        : [...current.assets, result.asset],
    } : current);
    setPhotoUri('');
    setPhotoBase64('');
  });

  const waterPlant = () => perform(async () => {
    if (!token) return;
    const result = await request<{ shared_state: Room['shared_state'] }>('/api/v1/room/water-plant', token, { method: 'POST' });
    setRoom((current) => current ? { ...current, shared_state: result.shared_state } : current);
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  });

  const sendNudge = async () => {
    if (!socket.current || socket.current.readyState !== WebSocket.OPEN) {
      setError('Live sync is not connected yet. Try again in a moment.');
      return;
    }
    socket.current.send(JSON.stringify({ event: 'haptic_nudge' }));
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  };

  const changeTrack = () => perform(async () => {
    const nextTrack = track.trim() || 'Night Bloom';
    if (!socket.current || socket.current.readyState !== WebSocket.OPEN) throw new Error('Live sync is not connected yet.');
    socket.current.send(JSON.stringify({ event: 'update_jukebox', track_id: nextTrack }));
    setTrack('');
  });

  const voteToUnmask = (accept: boolean) => perform(async () => {
    if (!token) return;
    const result = await request<{ status: string }>('/api/v1/room/unmask-opt-in', token, {
      method: 'POST',
      body: JSON.stringify({ accept }),
    });
    if (result.status === 'graduated') {
      setRoom(null);
      await loadCircle(token);
      setTab('circle');
    } else if (accept) {
      await loadRoom(token);
    } else {
      setRoom(null);
    }
  });

  const dissolveRoom = () => perform(async () => {
    if (!token) return;
    await request('/api/v1/room/dissolve', token, { method: 'POST' });
    setRoom(null);
  });

  const sendReport = () => perform(async () => {
    if (!token) return;
    await request('/api/v1/room/report', token, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Reported from the room safety menu.' }),
    });
    Alert.alert('Report received', 'Our safety team will review it.');
  });

  const sendMessage = () => perform(async () => {
    if (!token || !selectedFriendship || !messageText.trim()) return;
    await request(`/api/v1/circles/${selectedFriendship}/messages`, token, {
      method: 'POST',
      body: JSON.stringify({ content: messageText.trim() }),
    });
    setMessageText('');
    const result = await request<{ messages: Message[] }>(`/api/v1/circles/${selectedFriendship}/messages`, token);
    setMessages(result.messages);
  });

  const signOut = () => perform(async () => {
    if (token) await request('/api/v1/auth/logout', token, { method: 'POST' });
    await AsyncStorage.removeItem(TOKEN_KEY);
    socket.current?.close();
    setToken(null);
    setUser(null);
    setRoom(null);
    setFriendships([]);
  });

  if (loading) {
    return <SafeAreaView style={styles.center}><ActivityIndicator size="large" color="#76e1bd" /></SafeAreaView>;
  }

  if (!token) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ScrollView contentContainerStyle={styles.authPage} keyboardShouldPersistTaps="handled">
            <Text style={styles.eyebrow}>PUNE • PCMC</Text>
            <Text style={styles.hero}>Make room{'\n'}for a new kind{'\n'}of connection.</Text>
            <Text style={styles.body}>No swiping. Just two anonymous people, one shared space, and ten unhurried days.</Text>
            <Text style={styles.label}>PHONE NUMBER</Text>
            <Field value={phone} onChangeText={setPhone} keyboardType="phone-pad" placeholder="+91 98765 43210" />
            {otpRequested && <>
              <Text style={styles.label}>DEMO VERIFICATION CODE</Text>
              <Field value={otp} onChangeText={setOtp} keyboardType="number-pad" placeholder="6-digit code" />
              <Text style={styles.muted}>Local prototype only — the demo code is prefilled. No SMS is sent.</Text>
            </>}
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <Button label={busy ? 'Please wait…' : otpRequested ? 'Verify & enter' : 'Continue with phone'} onPress={otpRequested ? verifyOtp : requestOtp} disabled={busy} />
            <Text style={styles.disclaimer}>By continuing, you agree to keep this space kind and respectful.</Text>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  if (!user?.anonymous_handle) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
          <Text style={styles.eyebrow}>FIRST, A LITTLE ABOUT YOU</Text>
          <Text style={styles.heading}>Your anonymous self</Text>
          <Text style={styles.body}>Choose a handle and confirm you are in Pune. Your precise location is used for matching, not shown to your companion.</Text>
          <Text style={styles.label}>ANONYMOUS HANDLE</Text>
          <Field value={handle} onChangeText={setHandle} autoCapitalize="none" placeholder="e.g. softorbit" maxLength={30} />
          <Text style={styles.label}>NEIGHBORHOOD</Text>
          <Field value={neighborhood} onChangeText={setNeighborhood} placeholder="Baner, Pune" />
          <View style={styles.row}>
            <View style={styles.flex}>
              <Text style={styles.label}>LATITUDE</Text>
              <Field value={latitude} onChangeText={setLatitude} keyboardType="decimal-pad" placeholder="18.5204" />
            </View>
            <View style={styles.flex}>
              <Text style={styles.label}>LONGITUDE</Text>
              <Field value={longitude} onChangeText={setLongitude} keyboardType="decimal-pad" placeholder="73.8567" />
            </View>
          </View>
          <Button label="Use my current location" onPress={locateMe} variant="secondary" disabled={busy} />
          <Text style={styles.label}>VIBES, SEPARATED BY COMMAS</Text>
          <Field value={vibes} onChangeText={setVibes} placeholder="music, food, late walks" />
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Button label={busy ? 'Saving…' : 'Save my profile'} onPress={saveProfile} disabled={busy} />
          <Button label="Sign out" onPress={signOut} variant="quiet" disabled={busy} />
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.header}>
        <View>
          <Text style={styles.eyebrow}>PARALLEL LIVES</Text>
          <Text style={styles.headerTitle}>{tab === 'room' ? 'Your little world' : tab === 'circle' ? 'Your circle' : 'Your profile'}</Text>
        </View>
        <Text style={styles.handle}>@{user.anonymous_handle}</Text>
      </View>
      {!!error && <TouchableOpacity onPress={() => setError('')}><Text style={styles.errorBanner}>{error}  ×</Text></TouchableOpacity>}
      {tab === 'room' && (
        <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
          {room ? (
            <>
              <View style={styles.roomMeta}>
                <Text style={styles.pill}>DAY {room.day_streak} / {room.unmask_day_threshold}</Text>
                <Text style={styles.muted}>{room.partner?.neighborhood_tag || user.neighborhood_tag} · room {room.room_id.slice(0, 5)}</Text>
              </View>
              {room.demo_companion && <Text style={styles.demoNote}>This companion is simulated for the local MVP. Real-person matching is not enabled.</Text>}
              <View style={styles.roomCard}>
                <View style={styles.roomCanvas}>
                  <View style={styles.canvasWindow}>
                    {room.assets.filter((asset) => asset.asset_type === 'polaroid' && asset.media_url).slice(-1).map((asset) => (
                      <Image
                        key={asset.id}
                        source={{
                          uri: asset.media_url?.startsWith('/api/v1/media/') ? `${API_URL}${asset.media_url}` : asset.media_url!,
                          headers: asset.media_url?.startsWith('/api/v1/media/') ? { Authorization: `Bearer ${token}` } : undefined,
                        }}
                        style={styles.mirrorImage}
                        resizeMode="cover"
                      />
                    ))}
                    {!room.assets.some((asset) => asset.asset_type === 'polaroid') && <Text style={styles.windowText}>✦</Text>}
                  </View>
                  <Text style={styles.canvasCaption}>a place to just be</Text>
                  {room.assets.filter((asset) => asset.asset_type === 'sticky_note').slice(-1).map((asset) => (
                    <View key={asset.id} style={styles.wallNote}>
                      <Text style={styles.wallNoteAuthor}>
                        @{asset.author_id === user.id ? user.anonymous_handle : room.partner?.anonymous_handle}
                      </Text>
                      <Text style={styles.wallNoteText} numberOfLines={4}>{asset.content}</Text>
                    </View>
                  ))}
                  <Text style={styles.plantEmoji}>🪴</Text>
                  <Text style={styles.playerEmoji}>♫</Text>
                  <Text style={styles.roomSign}>ROOM 08</Text>
                </View>
                <View style={styles.statsRow}>
                  <View style={styles.stat}><Text style={styles.statCaption}>PLANT</Text><Text style={styles.statValue}>{room.shared_state.plant_health}%</Text></View>
                  <View style={styles.stat}><Text style={styles.statCaption}>ON REPEAT</Text><Text style={styles.statValue}>{room.shared_state.active_track || 'Room tone'}</Text></View>
                </View>
              </View>
              <View style={styles.row}>
                <View style={styles.flex}><Button label="Water plant" onPress={waterPlant} disabled={busy} /></View>
                <View style={styles.flex}><Button label="Coffee bump" onPress={sendNudge} variant="secondary" disabled={busy} /></View>
              </View>
              <View style={styles.panel}>
                <Text style={styles.panelTitle}>A song for the room</Text>
                <View style={styles.row}>
                  <View style={styles.flex}><Field value={track} onChangeText={setTrack} placeholder="Type a track name" /></View>
                  <Button label="Sync" onPress={changeTrack} variant="quiet" disabled={busy} />
                </View>
                <Text style={styles.muted}>Track names sync between connected room members; playback provider not connected.</Text>
              </View>
              <View style={styles.panel}>
                <Text style={styles.panelTitle}>Leave a little note</Text>
                <Field value={note} onChangeText={setNote} placeholder="Something you noticed today…" maxLength={140} multiline />
                <Text style={styles.muted}>{note.length}/140</Text>
                <Button label="Pin note to wall" onPress={postAsset} disabled={busy || !note.trim()} />
              </View>
              <View style={styles.panel}>
                <Text style={styles.panelTitle}>Add a polaroid</Text>
                {photoUri ? <Image source={{ uri: photoUri }} style={styles.photoPreview} /> : null}
                <Text style={styles.muted}>Photos are resized and EXIF metadata is removed. One upload per day, max 2 MB. Automated image moderation is not configured.</Text>
                <Button label={photoUri ? 'Choose a different photo' : 'Choose a photo'} onPress={choosePhoto} variant="quiet" disabled={busy} />
                <Button label="Pin polaroid to wall" onPress={uploadPolaroid} disabled={busy || !photoBase64} />
              </View>
              <View style={styles.panel}>
                <Text style={styles.panelTitle}>Things on your wall</Text>
                {room.assets.length ? room.assets.map((asset) => (
                  <View key={asset.id} style={styles.asset}>
                    <Text style={styles.assetType}>{asset.asset_type === 'sticky_note' ? 'NOTE' : 'POLAROID'} · @{asset.author_id === user.id ? user.anonymous_handle : room.partner?.anonymous_handle}</Text>
                    {asset.asset_type === 'sticky_note'
                      ? <Text style={styles.assetText}>{asset.content}</Text>
                      : asset.media_url?.startsWith('/api/v1/media/')
                        ? <Image source={{ uri: `${API_URL}${asset.media_url}`, headers: { Authorization: `Bearer ${token}` } }} style={styles.photoPreview} />
                        : asset.media_url
                          ? <Image source={{ uri: asset.media_url }} style={styles.photoPreview} />
                          : null}
                  </View>
                )) : <Text style={styles.muted}>The wall is waiting for its first memory.</Text>}
              </View>
              <View style={styles.panel}>
                <Text style={styles.panelTitle}>When it feels right</Text>
                <Text style={styles.body}>
                  {room.is_unmasked
                    ? 'You graduated together. Your unmasked circle is ready.'
                    : room.days_until_unmask > 0
                      ? `${room.days_until_unmask} more day${room.days_until_unmask === 1 ? '' : 's'} until day ${room.unmask_day_threshold}, when both of you can decide.`
                      : room.demo_companion
                        ? 'The local simulated companion will accept to let you preview the circle.'
                        : 'The choice is yours. Your companion’s yes is required too.'}
                </Text>
                {room.is_unmasked
                  ? <Button label="Open your circle" onPress={() => setTab('circle')} />
                  : <Button label={room.my_unmask_vote ? 'Waiting for your companion' : 'I want to unmask'} onPress={() => voteToUnmask(true)} disabled={busy || room.days_until_unmask > 0 || Boolean(room.my_unmask_vote)} />}
              </View>
              <Button label="Report a safety concern" onPress={sendReport} variant="quiet" disabled={busy} />
              <Button label="Leave this room" onPress={dissolveRoom} variant="danger" disabled={busy} />
            </>
          ) : (
            <View style={styles.emptyState}>
              <Text style={styles.emptyArt}>☼</Text>
              <Text style={styles.heading}>A room is waiting.</Text>
              <Text style={styles.body}>Find an anonymous companion nearby. Your location stays private, and you can leave whenever you want.</Text>
              <View style={styles.panel}>
                <Text style={styles.label}>YOUR COARSE AREA</Text>
                <Text style={styles.assetText}>{user.neighborhood_tag || 'Set your profile first'}</Text>
                <Text style={styles.muted}>Matching coordinates stay private and must be inside the Pune service area.</Text>
              </View>
              {error ? <Text style={styles.error}>{error}</Text> : null}
              <Button label={busy ? 'Finding your companion…' : 'Find a companion'} onPress={findCompanion} disabled={busy || user.latitude == null || user.longitude == null} />
              <Text style={styles.demoNote}>Single-user preview pairs you with a clearly labeled simulated companion. Production matching needs real participants.</Text>
            </View>
          )}
        </ScrollView>
      )}
      {tab === 'circle' && (
        <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
          {friendships.length === 0 ? (
            <View style={styles.emptyState}>
              <Text style={styles.heading}>Not quite yet.</Text>
              <Text style={styles.body}>Your circle appears when both people choose to unmask on day 10.</Text>
              <Button label="Back to room" onPress={() => setTab('room')} />
            </View>
          ) : (
            friendships.map((friendship) => (
              <TouchableOpacity key={friendship.friendship_id} style={styles.friendCard} onPress={() => setSelectedFriendship(friendship.friendship_id)}>
                <Text style={styles.friendName}>@{friendship.anonymous_handle}</Text>
                <Text style={styles.muted}>{friendship.neighborhood_tag} · Tap to open your conversation</Text>
                {friendship.verification_tier === 'demo' && <Text style={styles.demoNote}>Simulated companion · demo messages are not a real person.</Text>}
              </TouchableOpacity>
            ))
          )}
          {selectedFriendship && (
            <View style={styles.panel}>
              <Text style={styles.panelTitle}>Your conversation</Text>
              {messages.map((message) => (
                <View key={message.id} style={[styles.message, message.author_id === user.id && styles.myMessage]}>
                  <Text style={styles.assetText}>{message.content}</Text>
                  <Text style={styles.muted}>{message.author_id === user.id ? 'You' : 'Companion'}</Text>
                </View>
              ))}
              <Field value={messageText} onChangeText={setMessageText} placeholder="Say hello…" multiline maxLength={2000} />
              <Button label="Send message" onPress={sendMessage} disabled={busy || !messageText.trim()} />
            </View>
          )}
        </ScrollView>
      )}
      {tab === 'profile' && (
        <ScrollView contentContainerStyle={styles.page}>
          <View style={styles.panel}>
            <Text style={styles.panelTitle}>@{user.anonymous_handle}</Text>
            <Text style={styles.body}>{user.neighborhood_tag}</Text>
            <Text style={styles.muted}>{user.phone_number}</Text>
            <Text style={styles.muted}>Phone verification: demo-only OTP · Identity liveness: not configured</Text>
          </View>
          {room && <Button label="Decline & dissolve room" onPress={() => voteToUnmask(false)} variant="danger" disabled={busy} />}
          <Button label="Sign out" onPress={signOut} variant="quiet" disabled={busy} />
          <Text style={styles.demoNote}>Prototype notice: the local OTP is not SMS verification. Do not use real phone numbers or sensitive personal data.</Text>
        </ScrollView>
      )}
      <View style={styles.tabBar}>
        {(['room', 'circle', 'profile'] as const).map((item) => (
          <TouchableOpacity key={item} onPress={() => setTab(item)} style={styles.tab}>
            <Text style={[styles.tabText, tab === item && styles.tabTextActive]}>{item === 'room' ? 'ROOM' : item === 'circle' ? 'CIRCLE' : 'YOU'}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  safeArea: { flex: 1, backgroundColor: '#0c1020' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0c1020' },
  page: { padding: 20, paddingBottom: 36, gap: 14 },
  authPage: { flexGrow: 1, justifyContent: 'center', padding: 24, gap: 12 },
  header: { paddingHorizontal: 20, paddingTop: 18, paddingBottom: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  eyebrow: { color: '#76e1bd', fontSize: 11, fontWeight: '800', letterSpacing: 2 },
  hero: { color: '#f3f6ff', fontSize: 42, lineHeight: 48, fontWeight: '800', marginTop: 12 },
  heading: { color: '#f3f6ff', fontSize: 28, fontWeight: '800' },
  headerTitle: { color: '#f3f6ff', fontSize: 23, fontWeight: '800', marginTop: 5 },
  handle: { color: '#bac8e6', fontSize: 13 },
  body: { color: '#a9b7d6', fontSize: 15, lineHeight: 23 },
  muted: { color: '#8795b2', fontSize: 12, lineHeight: 18 },
  label: { color: '#a9b7d6', fontSize: 10, fontWeight: '800', letterSpacing: 1.5, marginTop: 8 },
  input: { minHeight: 48, borderRadius: 12, borderWidth: 1, borderColor: '#293650', backgroundColor: '#111a2c', color: '#f3f6ff', paddingHorizontal: 14, paddingVertical: 12, fontSize: 15 },
  button: { minHeight: 48, borderRadius: 13, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, paddingVertical: 13 },
  button_primary: { backgroundColor: '#76e1bd' },
  button_secondary: { backgroundColor: '#f5c26b' },
  button_quiet: { backgroundColor: '#202d47' },
  button_danger: { backgroundColor: '#512f42' },
  buttonDisabled: { opacity: 0.48 },
  buttonText: { fontSize: 14, fontWeight: '800' },
  buttonText_primary: { color: '#08170f' },
  buttonText_secondary: { color: '#23190d' },
  buttonText_quiet: { color: '#e2eaff' },
  buttonText_danger: { color: '#ffdbe4' },
  disclaimer: { color: '#7886a2', fontSize: 12, lineHeight: 18, textAlign: 'center', marginTop: 16 },
  error: { color: '#ff9eab', fontSize: 13, lineHeight: 19 },
  errorBanner: { color: '#ffdce2', backgroundColor: '#512f42', paddingHorizontal: 16, paddingVertical: 9, marginHorizontal: 16, borderRadius: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  roomMeta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  pill: { color: '#101a28', fontSize: 11, fontWeight: '900', letterSpacing: 1, backgroundColor: '#76e1bd', borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7 },
  demoNote: { color: '#e8c98e', backgroundColor: '#392f23', borderRadius: 12, padding: 12, fontSize: 12, lineHeight: 18 },
  roomCard: { backgroundColor: '#152039', borderColor: '#263653', borderWidth: 1, borderRadius: 22, padding: 12 },
  roomCanvas: { height: 225, overflow: 'hidden', borderRadius: 16, backgroundColor: '#eadfd1', justifyContent: 'center', alignItems: 'center' },
  wallNote: { position: 'absolute', left: 18, top: 54, width: 142, minHeight: 82, padding: 10, borderRadius: 3, backgroundColor: '#f6df8a', transform: [{ rotate: '-2deg' }], shadowColor: '#000000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.16, shadowRadius: 4, elevation: 3 },
  wallNoteAuthor: { color: '#746746', fontSize: 8, fontWeight: '800', marginBottom: 5 },
  wallNoteText: { color: '#403927', fontSize: 12, lineHeight: 16 },
  photoPreview: { width: '100%', height: 210, borderRadius: 12, backgroundColor: '#202f4a' },
  canvasWindow: { position: 'absolute', right: 28, top: 22, width: 72, height: 86, overflow: 'hidden', borderRadius: 8, borderWidth: 5, borderColor: '#c7ae8d', backgroundColor: '#b2d0cf', alignItems: 'center', justifyContent: 'center' },
  mirrorImage: { width: '100%', height: '100%' },
  windowText: { color: '#fff7dc', fontSize: 32 },
  canvasCaption: { color: '#756557', position: 'absolute', top: 18, left: 16, fontSize: 12, fontStyle: 'italic' },
  plantEmoji: { fontSize: 58, position: 'absolute', bottom: 20, left: 32 },
  playerEmoji: { fontSize: 42, position: 'absolute', bottom: 30, right: 42, color: '#34364a' },
  roomSign: { color: '#846d56', position: 'absolute', bottom: 14, fontSize: 9, letterSpacing: 3 },
  statsRow: { flexDirection: 'row', gap: 10, paddingTop: 12 },
  stat: { flex: 1, backgroundColor: '#202f4a', borderRadius: 13, padding: 12 },
  statCaption: { color: '#9bb0d5', fontSize: 9, letterSpacing: 1.2, fontWeight: '800' },
  statValue: { color: '#f5f7ff', fontSize: 16, fontWeight: '700', marginTop: 7 },
  panel: { backgroundColor: '#121d35', borderRadius: 16, padding: 16, gap: 10, borderWidth: 1, borderColor: '#202e49' },
  panelTitle: { color: '#f3f6ff', fontSize: 17, fontWeight: '800' },
  asset: { paddingVertical: 12, borderTopColor: '#293650', borderTopWidth: 1, gap: 6 },
  assetType: { color: '#76e1bd', fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  assetText: { color: '#edf2ff', fontSize: 15, lineHeight: 21 },
  emptyState: { flex: 1, minHeight: 460, justifyContent: 'center', gap: 16 },
  emptyArt: { color: '#76e1bd', fontSize: 60 },
  friendCard: { backgroundColor: '#152039', borderRadius: 15, padding: 16, gap: 6 },
  friendName: { color: '#f3f6ff', fontSize: 17, fontWeight: '800' },
  message: { backgroundColor: '#202f4a', borderRadius: 12, padding: 12, gap: 5, alignSelf: 'flex-start', maxWidth: '90%' },
  myMessage: { backgroundColor: '#285747', alignSelf: 'flex-end' },
  tabBar: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: '#202e49', backgroundColor: '#10182a', paddingBottom: Platform.OS === 'ios' ? 4 : 0 },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 14 },
  tabText: { color: '#77839a', fontSize: 10, fontWeight: '800', letterSpacing: 1.5 },
  tabTextActive: { color: '#76e1bd' },
});
