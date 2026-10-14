import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAudioPlayer } from 'expo-audio';
import * as Haptics from 'expo-haptics';
import * as ImageManipulator from 'expo-image-manipulator';
import * as Location from 'expo-location';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Alert,
  Image,
  ImageBackground,
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
const VIBE_OPTIONS = ['music', 'coffee', 'slow-life', 'food', 'books', 'walks', 'art', 'nature'];
const BEACON_STAGES = [
  { emoji: '🏮', title: 'Waiting for a spark', detail: 'Your first shared answer will light the island beacon.', size: 24 },
  { emoji: '🏮', title: 'First little glow', detail: 'One shared day. The beacon has its first warm glow.', size: 28 },
  { emoji: '🏮', title: 'Growing brighter', detail: 'Two shared days. Your island light is growing brighter.', size: 32 },
  { emoji: '🏮', title: 'Our island beacon', detail: 'Three shared days. You built a light together.', size: 36 },
];
const ROOM_SOUNDTRACKS = [
  { id: 'room-tone', title: 'Room tone', source: require('./assets/soundscapes/room-tone.wav') },
  { id: 'rain-on-glass', title: 'Rain on glass', source: require('./assets/soundscapes/rain-on-glass.wav') },
  { id: 'river-walk', title: 'River walk', source: require('./assets/soundscapes/river-walk.wav') },
  { id: 'morning-birds', title: 'Morning birds', source: require('./assets/soundscapes/morning-birds.wav') },
  { id: 'wind-in-leaves', title: 'Wind in leaves', source: require('./assets/soundscapes/wind-in-leaves.wav') },
  { id: 'ocean-hush', title: 'Ocean hush', source: require('./assets/soundscapes/ocean-hush.wav') },
  { id: 'night-crickets', title: 'Night crickets', source: require('./assets/soundscapes/night-crickets.wav') },
  { id: 'cafe-window', title: 'Cafe window', source: require('./assets/soundscapes/cafe-window.wav') },
  { id: 'forest-dawn', title: 'Forest dawn', source: require('./assets/soundscapes/forest-dawn.wav') },
  { id: 'soft-fireplace', title: 'Soft fireplace', source: require('./assets/soundscapes/soft-fireplace.wav') },
];
const isLocalDaytime = () => {
  const hour = new Date().getHours();
  return hour >= 6 && hour < 18;
};
function BirdSilhouette({ flap, night, small = false }: { flap: Animated.Value; night: boolean; small?: boolean }) {
  const wingUp = flap.interpolate({ inputRange: [0, 1], outputRange: ['-38deg', '22deg'] });
  const wingDown = flap.interpolate({ inputRange: [0, 1], outputRange: ['38deg', '-22deg'] });
  const color = night ? '#b6c4cc' : '#29445c';
  return (
    <View style={[styles.birdShape, small && styles.birdShapeSmall]}>
      <Animated.View style={[styles.birdWing, styles.birdWingLeft, { backgroundColor: color, transform: [{ rotate: wingUp }] }]} />
      <Animated.View style={[styles.birdWing, styles.birdWingRight, { backgroundColor: color, transform: [{ rotate: wingDown }] }]} />
      <View style={[styles.birdBody, { backgroundColor: color }]} />
      <View style={[styles.birdHead, { backgroundColor: color }]} />
      <View style={[styles.birdTail, { borderTopColor: color }]} />
    </View>
  );
}

type User = {
  id: string;
  phone_number: string;
  anonymous_handle: string;
  neighborhood_tag: string;
  latitude: number | null;
  longitude: number | null;
};

type EmotionTag = 'happy' | 'funny' | 'deep' | 'comforting' | 'random';
type Asset = {
  id: string;
  author_id: string;
  asset_type: string;
  content: string | null;
  media_url: string | null;
  emotion_tag?: EmotionTag | null;
  source_message_id?: string | null;
  created_at: string;
};

type Room = {
  room_id: string;
  created_at: string;
  room_level: number;
  day_streak: number;
  days_elapsed: number;
  daily_prompt: {
    day: number;
    question: string;
    my_answer: string | null;
    partner_answer: string | null;
    revealed: boolean;
  };
  shared_prompts: { day: number; question: string; my_answer: string; partner_answer: string }[];
  share_more: {
    available: boolean;
    my_vote: number | null;
    mutual: boolean;
    response_expires_at: string | null;
    partner_vibe_tags: string[];
  };
  plant_growth: { stage: number; completed_days: number };
  partner_inactive_hours: number | null;
  can_rematch: boolean;
  days_until_unmask: number;
  unmask_day_threshold: number;
  shared_state: { plant_health: number; theme: string; [key: string]: unknown };
  assets: Asset[];
  partner: { anonymous_handle: string; neighborhood_tag: string; verification_tier: string } | null;
  demo_companion: boolean;
};

type MatchStatus =
  | { status: 'idle' }
  | { status: 'waiting'; queued_at: string }
  | { status: 'matched'; room: Room };
type MatchSearchResult = Room | { status: 'waiting'; queued_at: string };

type Message = { id: string; author_id: string; content: string; created_at: string };
type Friendship = {
  friendship_id: string;
  partner_id: string;
  anonymous_handle: string;
  neighborhood_tag: string;
  verification_tier: string;
  created_at: string;
  continue_expires_at: string | null;
  continue_available: boolean;
  continue_blocked: boolean;
  my_continue_vote: number | null;
  partner_continue_vote: number | null;
  continue_response_expires_at: string | null;
  world_active: boolean;
};
async function getDeviceCoordinates(): Promise<{ latitude: number; longitude: number }> {
  const permission = await Location.requestForegroundPermissionsAsync();
  if (permission.status !== 'granted') throw new Error('Location permission is required for Pune matching.');
  const provider = await Location.getProviderStatusAsync();
  if (!provider.locationServicesEnabled) {
    throw new Error('Turn on Android Location services, then try again. In BlueStacks also set a location from its side toolbar.');
  }
  if (Platform.OS === 'android') await Location.enableNetworkProviderAsync().catch(() => undefined);
  let position = await Location.getLastKnownPositionAsync({ maxAge: 120_000, requiredAccuracy: 5_000 });
  if (!position) {
    try {
      position = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
        mayShowUserSettingsDialog: true,
      });
    } catch {
      throw new Error('BlueStacks did not return a location. Set it from the side toolbar, or use the development-only Pune test location.');
    }
  }
  return { latitude: position.coords.latitude, longitude: position.coords.longitude };
}

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

function EmotionPicker({ selected, onSelect }: {
  selected: EmotionTag | '';
  onSelect: (value: EmotionTag | '') => void;
}) {
  const tags: { value: EmotionTag; label: string; icon: string }[] = [
    { value: 'happy', label: 'Happy', icon: '☀' },
    { value: 'funny', label: 'Funny', icon: '☻' },
    { value: 'deep', label: 'Deep', icon: '✦' },
    { value: 'comforting', label: 'Comforting', icon: '♡' },
    { value: 'random', label: 'Random', icon: '✿' },
  ];
  return (
    <View style={styles.emotionPicker}>
      <TouchableOpacity accessibilityRole="button" onPress={() => onSelect('')} style={[styles.emotionChip, !selected && styles.emotionChipActive]}>
        <Text style={styles.emotionText}>No tag</Text>
      </TouchableOpacity>
      {tags.map((tag) => (
        <TouchableOpacity key={tag.value} accessibilityRole="button" onPress={() => onSelect(tag.value)} style={[styles.emotionChip, selected === tag.value && styles.emotionChipActive]}>
          <Text style={styles.emotionText}>{tag.icon} {tag.label}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

function MemoryCard({ asset, ownerId, ownerHandle, partnerHandle, token }: {
  asset: Asset;
  ownerId: string;
  ownerHandle: string;
  partnerHandle: string;
  token: string | null;
}) {
  const author = asset.author_id === ownerId ? ownerHandle : partnerHandle;
  const kind = asset.asset_type === 'sticky_note' ? 'NOTE' : asset.asset_type === 'chat_memory' ? 'CHAT MOMENT' : 'PHOTO';
  return (
    <View style={styles.memoryCard}>
      <View style={styles.memoryCardHeader}>
        <Text style={styles.assetType}>{kind} · @{author}</Text>
        {asset.emotion_tag ? <Text style={styles.memoryEmotion}>{asset.emotion_tag}</Text> : null}
      </View>
      {asset.asset_type === 'polaroid' && asset.media_url ? (
        <Image source={{ uri: asset.media_url.startsWith('/api/v1/media/') ? `${API_URL}${asset.media_url}` : asset.media_url, headers: asset.media_url.startsWith('/api/v1/media/') && token ? { Authorization: `Bearer ${token}` } : undefined }} style={styles.memoryImage} />
      ) : <Text style={styles.assetText}>{asset.content}</Text>}
      <Text style={styles.muted}>{new Date(asset.created_at).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}</Text>
    </View>
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
    const [usingTestLocation, setUsingTestLocation] = useState(false);
  const [vibes, setVibes] = useState(['music', 'coffee', 'slow-life']);
  const [room, setRoom] = useState<Room | null>(null);
  const [activeLocation, setActiveLocation] = useState<'home' | 'tree' | 'garden' | 'photos' | 'journal' | 'bridge'>('home');
  const [roomSoundtrackIndex, setRoomSoundtrackIndex] = useState(0);
  const [isDaytime, setIsDaytime] = useState(isLocalDaytime);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [memoryEmotion, setMemoryEmotion] = useState<EmotionTag | ''>('');
  const [memoryType, setMemoryType] = useState<'all' | 'sticky_note' | 'polaroid' | 'chat_memory'>('all');
  const [memoryTime, setMemoryTime] = useState<'all' | 'days' | 'months'>('all');
  const [assetEmotion, setAssetEmotion] = useState<EmotionTag | ''>('');
  const [photoEmotion, setPhotoEmotion] = useState<EmotionTag | ''>('');
  const [matching, setMatching] = useState(false);
  const [queuedAt, setQueuedAt] = useState<string | null>(null);
  const [tab, setTab] = useState<'room' | 'circle' | 'profile'>('room');
  const [note, setNote] = useState('');
  const [promptAnswer, setPromptAnswer] = useState('');
  const [photoUri, setPhotoUri] = useState('');
  const [photoBase64, setPhotoBase64] = useState('');
  const [photoType, setPhotoType] = useState('image/jpeg');
  const [polaroidClock, setPolaroidClock] = useState(Date.now());
  const [roomMessages, setRoomMessages] = useState<Message[]>([]);
  const [roomMessageText, setRoomMessageText] = useState('');
  const [roomChatOpen, setRoomChatOpen] = useState(false);
  const [partnerOnline, setPartnerOnline] = useState(false);
  const [friendships, setFriendships] = useState<Friendship[]>([]);
  const [selectedFriendship, setSelectedFriendship] = useState<string | null>(null);
  const [circleSearch, setCircleSearch] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [messageText, setMessageText] = useState('');
  const socket = useRef<WebSocket | null>(null);
  const roomChatScrollRef = useRef<ScrollView | null>(null);
  const roomPageScrollRef = useRef<ScrollView | null>(null);
  const wallSectionY = useRef(0);
  const circleChatScrollRef = useRef<ScrollView | null>(null);
  const ambientPlayer = useAudioPlayer(ROOM_SOUNDTRACKS[0].source);
  const islandDayFade = useRef(new Animated.Value(isDaytime ? 1 : 0)).current;
  const birdFlight = useRef(new Animated.Value(0)).current;
  const birdFlightSecond = useRef(new Animated.Value(0)).current;
  const birdFlap = useRef(new Animated.Value(0)).current;
  const waterfallFlow = useRef(new Animated.Value(0)).current;
  const treeSway = useRef(new Animated.Value(0)).current;
  const latestWallNote = room?.assets.filter((asset) => asset.asset_type === 'sticky_note').at(-1);
  const latestWallPolaroid = room?.assets.filter((asset) => asset.asset_type === 'polaroid').at(-1);
  const latestMyPolaroid = room?.assets.filter((asset) => asset.asset_type === 'polaroid' && asset.author_id === user?.id).at(-1);
  const polaroidCooldownUntil = latestMyPolaroid ? new Date(latestMyPolaroid.created_at).getTime() + 24 * 60 * 60 * 1000 : 0;
  const polaroidCooldownMs = Math.max(0, polaroidCooldownUntil - polaroidClock);
  const polaroidCooldownLabel = `${String(Math.floor(polaroidCooldownMs / 3600000)).padStart(2, '0')}:${String(Math.floor((polaroidCooldownMs % 3600000) / 60000)).padStart(2, '0')}:${String(Math.floor((polaroidCooldownMs % 60000) / 1000)).padStart(2, '0')}`;
  const polaroidCoolingDown = polaroidCooldownMs > 0;
  const shareMoreExpiryMs = room?.share_more.response_expires_at
    ? Math.max(0, new Date(room.share_more.response_expires_at).getTime() - polaroidClock)
    : 0;
  const shareMoreExpiryLabel = `${String(Math.floor(shareMoreExpiryMs / 3600000)).padStart(2, '0')}:${String(Math.floor((shareMoreExpiryMs % 3600000) / 60000)).padStart(2, '0')}:${String(Math.floor((shareMoreExpiryMs % 60000) / 1000)).padStart(2, '0')}`;
  const recentHangingPhotos = room?.assets.filter((asset) => asset.asset_type === 'polaroid' && asset.media_url).slice(-3, -1) || [];
  const roomSoundtrack = ROOM_SOUNDTRACKS[roomSoundtrackIndex];
  const visibleFriendships = friendships.filter((friendship) => `${friendship.anonymous_handle} ${friendship.neighborhood_tag}`.toLowerCase().includes(circleSearch.trim().toLowerCase()));
  const changeRoomSoundtrack = () => setRoomSoundtrackIndex((current) => (current + 1) % ROOM_SOUNDTRACKS.length);
  const toggleRoomSound = () => {
    if (soundEnabled) {
      ambientPlayer.pause();
      ambientPlayer.volume = 0;
      setSoundEnabled(false);
    } else {
      ambientPlayer.volume = 0.2;
      ambientPlayer.play();
      setSoundEnabled(true);
    }
  };

  useEffect(() => {
    ambientPlayer.pause();
    ambientPlayer.replace(roomSoundtrack.source);
    ambientPlayer.loop = true;
  }, [ambientPlayer, roomSoundtrack.source]);

  useEffect(() => {
    if (!polaroidCoolingDown && !room?.share_more.response_expires_at) return;
    const timer = setInterval(() => setPolaroidClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [polaroidCoolingDown, room?.share_more.response_expires_at]);

  useEffect(() => {
    if (room?.room_id && tab === 'room' && !roomChatOpen && soundEnabled) {
      ambientPlayer.volume = 0.2;
      ambientPlayer.play();
    } else {
      ambientPlayer.pause();
      ambientPlayer.volume = 0;
    }
  }, [ambientPlayer, room?.room_id, roomChatOpen, roomSoundtrack.source, soundEnabled, tab]);

  useEffect(() => {
    const timer = setInterval(() => setIsDaytime(isLocalDaytime()), 60_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    Animated.timing(islandDayFade, { toValue: isDaytime ? 1 : 0, duration: 1000, useNativeDriver: true }).start();
  }, [isDaytime, islandDayFade]);

  useEffect(() => {
    const firstBird = Animated.loop(Animated.timing(birdFlight, { toValue: 1, duration: 13_000, useNativeDriver: true }));
    const secondBird = Animated.loop(Animated.timing(birdFlightSecond, { toValue: 1, duration: 17_000, useNativeDriver: true }));
    const flap = Animated.loop(Animated.sequence([
      Animated.timing(birdFlap, { toValue: 1, duration: 220, useNativeDriver: true }),
      Animated.timing(birdFlap, { toValue: 0, duration: 220, useNativeDriver: true }),
    ]));
    const water = Animated.loop(Animated.timing(waterfallFlow, { toValue: 1, duration: 1_000, useNativeDriver: true }));
    const breeze = Animated.loop(Animated.sequence([
      Animated.timing(treeSway, { toValue: 1, duration: 3_000, useNativeDriver: true }),
      Animated.timing(treeSway, { toValue: 0, duration: 3_000, useNativeDriver: true }),
    ]));
    firstBird.start();
    secondBird.start();
    flap.start();
    water.start();
    breeze.start();
    return () => { firstBird.stop(); secondBird.stop(); flap.stop(); water.stop(); breeze.stop(); };
  }, [birdFlight, birdFlightSecond, birdFlap, waterfallFlow, treeSway]);

  useEffect(() => {
    if (roomChatOpen) roomChatScrollRef.current?.scrollToEnd({ animated: true });
  }, [roomChatOpen, roomMessages.length]);

  useEffect(() => {
    if (selectedFriendship) circleChatScrollRef.current?.scrollToEnd({ animated: true });
  }, [messages.length, selectedFriendship]);

  const reportError = useCallback((reason: unknown) => {
    setError(reason instanceof Error ? reason.message : 'Something went wrong. Please try again.');
  }, []);

  const applyMatchStatus = useCallback((status: MatchStatus) => {
    if (status.status === 'matched') {
      setRoom(status.room);
      setActiveLocation('home');
      setMatching(false);
      setQueuedAt(null);
    } else if (status.status === 'waiting') {
      setRoom(null);
      setMatching(true);
      setQueuedAt(status.queued_at);
    } else {
      setMatching(false);
      setQueuedAt(null);
    }
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
      const matchStatus = await request<MatchStatus>('/api/v1/match/status', accessToken);
      applyMatchStatus(matchStatus);
    }
  }, [applyMatchStatus, loadCircle, loadRoom]);

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
    const presencePulse = setInterval(() => {
      if (connection.readyState === WebSocket.OPEN) {
        connection.send(JSON.stringify({ event: 'presence', online: true }));
      }
    }, 60_000);
    connection.onopen = () => connection.send(JSON.stringify({ event: 'presence', online: true }));
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
          setRoomMessages([]);
          setError('This island has ended. Its room chat and saved photos were deleted.');
        } else if (data.event === 'room_message') {
          setRoomMessages((current) => current.some((message) => message.id === data.payload.id)
            ? current
            : [...current, data.payload]);
        } else if (data.event === 'daily_prompt_updated') {
          loadRoom(token).catch(reportError);
        } else if (data.event === 'share_more_updated') {
          loadRoom(token).catch(reportError);
        } else if (data.event === 'room_message') {
          setRoomMessages((current) => current.some((message) => message.id === data.payload.id)
            ? current
            : [...current, data.payload]);
        } else if (data.event === 'presence_glow') {
          if (data.payload?.from && data.payload.from !== user?.id) setPartnerOnline(Boolean(data.payload.online));
        } else if (data.event === 'haptic_nudge') {
          if (data.payload?.from !== user?.id) {
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            Alert.alert('Coffee bump', 'Your companion sent a little hello.');
          }
        } else if (data.event === 'unmask_updated') {
          if (data.payload?.status === 'graduated') {
            setRoom(null);
            setRoomChatOpen(false);
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
      clearInterval(presencePulse);
      connection.close();
      if (socket.current === connection) socket.current = null;
    };
  }, [loadCircle, loadRoom, reportError, room?.room_id, token, user?.id]);

  useEffect(() => {
    if (!token || !room?.room_id) return undefined;
    let active = true;
    const refreshRoomContent = async () => {
      try {
        const [roomData, messageData] = await Promise.all([
          request<Room>('/api/v1/room/active', token),
          request<{ messages: Message[] }>('/api/v1/room/messages', token),
        ]);
        if (active) {
          setRoom(roomData);
          setRoomMessages(messageData.messages);
        }
      } catch (reason) {
        if (active && reason instanceof Error && reason.message.includes('active room')) {
          setRoom(null);
          setRoomMessages([]);
          setError('No reply arrived within 24 hours. This island and its saved memories were deleted.');
        } else if (active) reportError(reason);
      }
    };
    const timer = setInterval(refreshRoomContent, 4000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [reportError, room?.room_id, token]);

  useEffect(() => {
    if (!token || !matching) return undefined;
    let active = true;
    const checkMatch = async () => {
      try {
        const status = await request<MatchStatus>('/api/v1/match/status', token);
        if (!active) return;
        if (status.status === 'idle') {
          setMatching(false);
          setQueuedAt(null);
          setError('The search expired before anyone nearby joined. You can start a new search anytime.');
        } else {
          applyMatchStatus(status);
        }
      } catch (reason) {
        if (active) reportError(reason);
      }
    };
    checkMatch();
    const timer = setInterval(checkMatch, 2500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [applyMatchStatus, matching, reportError, token]);

  useEffect(() => {
    if (!token || !room?.room_id) {
      setRoomMessages([]);
      return undefined;
    }
    let active = true;
    request<{ messages: Message[] }>('/api/v1/room/messages', token)
      .then((result) => {
        if (active) setRoomMessages(result.messages);
      })
      .catch((reason) => {
        if (active) reportError(reason);
      });
    return () => {
      active = false;
    };
  }, [reportError, room?.room_id, token]);

  useEffect(() => {
    if (!token || tab !== 'circle' || !selectedFriendship) return undefined;
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
  }, [reportError, selectedFriendship, tab, token]);

  useEffect(() => {
    if (!token || tab !== 'circle') return undefined;
    let active = true;
    const refreshCircle = async () => {
      try {
        const result = await request<{ friendships: Friendship[] }>('/api/v1/circles', token);
        if (!active) return;
        setFriendships(result.friendships);
        if (result.friendships.some((friendship) => friendship.world_active)) {
          await loadRoom(token);
          if (active) setTab('room');
        }
      } catch (reason) {
        if (active) reportError(reason);
      }
    };
    const timer = setInterval(refreshCircle, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [loadRoom, reportError, tab, token]);

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
    const coordinates = await getDeviceCoordinates();
    setLatitude(coordinates.latitude.toFixed(6));
    setLongitude(coordinates.longitude.toFixed(6));
    setUsingTestLocation(false);
  });

  const usePuneTestLocation = () => {
    setLatitude('18.520400');
    setLongitude('73.856700');
    setUsingTestLocation(true);
    setError('');
  };

  const toggleVibe = (vibe: string) => {
    setVibes((current) => current.includes(vibe)
      ? current.filter((selected) => selected !== vibe)
      : [...current, vibe]);
  };

  const saveProfile = () => perform(async () => {
    if (!token) return;
    const result = await request<{ user: User }>('/api/v1/profile', token, {
      method: 'POST',
      body: JSON.stringify({
        handle,
        neighborhood,
        latitude: Number(latitude),
        longitude: Number(longitude),
        vibes,
      }),
    });
    setUser({ ...user!, ...result.user });
    setError('');
  });

  const findCompanion = () => perform(async () => {
    if (!token) return;
    setError('');
    setActiveLocation('home');
    setRoom(null);
    setMatching(true);
    try {
      const coordinates = usingTestLocation && latitude && longitude
        ? { latitude: Number(latitude), longitude: Number(longitude) }
        : await getDeviceCoordinates();
      setLatitude(coordinates.latitude.toFixed(6));
      setLongitude(coordinates.longitude.toFixed(6));
      const result = await request<MatchSearchResult>('/api/v1/match/find-companion', token, {
        method: 'POST',
        body: JSON.stringify({
          latitude: coordinates.latitude,
          longitude: coordinates.longitude,
          vibe_filters: vibes,
        }),
      });
      if ('room_id' in result) {
        setRoom(result);
        setMatching(false);
        setQueuedAt(null);
      } else {
        setQueuedAt(result.queued_at);
      }
      setTab('room');
      if (!('status' in result) || result.status !== 'waiting') {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
    } catch (reason) {
      setMatching(false);
      setQueuedAt(null);
      throw reason;
    }
  });

  const cancelMatchSearch = () => perform(async () => {
    if (!token) return;
    const result = await request<{ status: string }>('/api/v1/match/queue', token, { method: 'DELETE' });
    if (result.status === 'cancelled') {
      setMatching(false);
      setQueuedAt(null);
    } else {
      applyMatchStatus(await request<MatchStatus>('/api/v1/match/status', token));
    }
  });

  const postAsset = () => perform(async () => {
    if (!token) return;
    const result = await request<{ asset: Asset }>('/api/v1/room/asset', token, {
      method: 'POST',
      body: JSON.stringify({
        asset_type: 'sticky_note',
        content: note.trim(),
        emotion_tag: assetEmotion || null,
      }),
    });
    setRoom((current) => current ? {
      ...current,
      assets: current.assets.some((asset) => asset.id === result.asset.id)
        ? current.assets
        : [...current.assets, result.asset],
    } : current);
    setNote('');
    setAssetEmotion('');
  });

  const saveChatMemory = (message: Message) => perform(async () => {
    if (!token) return;
    const result = await request<{ asset: Asset }>('/api/v1/room/asset', token, {
      method: 'POST',
      body: JSON.stringify({ asset_type: 'chat_memory', message_id: message.id, emotion_tag: assetEmotion || null }),
    });
    setRoom((current) => current ? { ...current, assets: [...current.assets, result.asset] } : current);
    await loadRoom(token);
    setAssetEmotion('');
  });

  const answerDailyPrompt = () => perform(async () => {
    if (!token || !room || !promptAnswer.trim()) return;
    const result = await request<{ daily_prompt: Room['daily_prompt'] }>('/api/v1/room/daily-prompt', token, {
      method: 'POST',
      body: JSON.stringify({ day: room.daily_prompt.day, answer: promptAnswer.trim() }),
    });
    await loadRoom(token);
    setPromptAnswer('');
  });

  const sendRoomMessage = () => perform(async () => {
    if (!token || !roomMessageText.trim()) return;
    const result = await request<{ message: Message }>('/api/v1/room/messages', token, {
      method: 'POST',
      body: JSON.stringify({ content: roomMessageText.trim() }),
    });
    setRoomMessages((current) => current.some((message) => message.id === result.message.id)
      ? current
      : [...current, result.message]);
    setRoomMessageText('');
  });

  const shareMore = (accept: boolean) => perform(async () => {
    if (!token) return;
    const result = await request<{ status: string }>('/api/v1/room/share-more', token, {
      method: 'POST',
      body: JSON.stringify({ accept }),
    });
    if (result.status === 'graduated') {
      setRoom(null);
      setRoomChatOpen(false);
      await loadCircle(token);
      setTab('circle');
      setActiveLocation('home');
    } else if (result.status === 'dissolved') {
      setRoom(null);
      setRoomMessages([]);
      setRoomChatOpen(false);
      setError('This island has ended. Its room chat and saved photos were deleted.');
    } else {
      await loadRoom(token);
    }
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
      body: JSON.stringify({ image_base64: photoBase64, content_type: photoType, emotion_tag: photoEmotion || null }),
    });
    setRoom((current) => current ? {
      ...current,
      assets: current.assets.some((asset) => asset.id === result.asset.id)
        ? current.assets
        : [...current.assets, result.asset],
    } : current);
    setPhotoUri('');
    setPhotoBase64('');
    setPhotoEmotion('');
  });

  const sendNudge = async () => {
    if (!socket.current || socket.current.readyState !== WebSocket.OPEN) {
      setError('Live sync is not connected yet. Try again in a moment.');
      return;
    }
    socket.current.send(JSON.stringify({ event: 'haptic_nudge' }));
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  };

  const dissolveRoom = () => Alert.alert(
    'Delete this island?',
    'Your shared chat, notes, photos, and journal answers will be permanently deleted for both of you.',
    [
      { text: 'Keep the island', style: 'cancel' },
      { text: 'Delete and leave', style: 'destructive', onPress: () => perform(async () => {
        if (!token) return;
        await request('/api/v1/room/dissolve', token, { method: 'POST' });
        setRoom(null);
        setRoomMessages([]);
      }) },
    ],
  );

  const blockPartner = () => Alert.alert(
    'Block and leave this room?',
    'You will leave the room and this account will not be matched with you again.',
    [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Block and leave', style: 'destructive', onPress: () => perform(async () => {
        if (!token) return;
        await request('/api/v1/room/block', token, { method: 'POST' });
        setRoom(null);
        setRoomMessages([]);
      }) },
    ],
  );

  const leaveAndRematch = () => Alert.alert(
    'Find another connection?',
    'This room has been quiet for a day. You can leave it and try another room.',
    [
      { text: 'Stay here', style: 'cancel' },
      { text: 'Leave and rematch', onPress: () => perform(async () => {
        if (!token) return;
        await request('/api/v1/room/dissolve', token, { method: 'POST' });
        setRoom(null);
        setRoomMessages([]);
        const nextMatch = await request<MatchSearchResult>('/api/v1/match/find-companion', token, {
          method: 'POST',
          body: JSON.stringify({
            latitude: Number(latitude || user?.latitude),
            longitude: Number(longitude || user?.longitude),
            vibe_filters: vibes,
          }),
        });
        if ('room_id' in nextMatch) {
          setRoom(nextMatch);
          setMatching(false);
        } else {
          setMatching(true);
          setQueuedAt(nextMatch.queued_at);
        }
      }) },
    ],
  );

  const sendReport = (reason: string) => perform(async () => {
    if (!token) return;
    await request('/api/v1/room/report', token, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
    Alert.alert('Report received', 'Our safety team will review it.');
  });

  const reportSafetyConcern = () => Alert.alert('Report a safety concern', 'Choose the closest reason.', [
    { text: 'Harassment or hateful behavior', onPress: () => sendReport('Harassment or hateful behavior') },
    { text: 'Privacy or unwanted pressure', onPress: () => sendReport('Privacy or unwanted pressure') },
    { text: 'Cancel', style: 'cancel' },
  ]);

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

  const continueSharedWorld = (friendshipId: string) => perform(async () => {
    if (!token) return;
    const result = await request<{ status: string }>('/api/v1/circles/' + friendshipId + '/continue', token, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    await loadCircle(token);
    if (result.status === 'continued') {
      await loadRoom(token);
      setSelectedFriendship(null);
      setTab('room');
    }
  });

  const removeCirclePerson = (friendshipId: string, action: 'remove' | 'block' | 'report', reason?: string) => perform(async () => {
    if (!token) return;
    const endpoint = action === 'report'
      ? `/api/v1/circles/${friendshipId}/report`
      : `/api/v1/circles/${friendshipId}/${action}`;
    const result = await request<{ status: string; room_id: string }>(endpoint, token, {
      method: 'POST',
      ...(action === 'report' ? { body: JSON.stringify({ reason }) } : {}),
    });
    if (room?.room_id && result.room_id === room.room_id) {
      setRoom(null);
      setRoomMessages([]);
    }
    setSelectedFriendship(null);
    setMessages([]);
    await loadCircle(token);
    Alert.alert(
      action === 'report' ? 'Report sent' : action === 'block' ? 'Person blocked' : 'Connection removed',
      action === 'report'
        ? 'The connection and shared data were deleted for both of you. This person is blocked from future matches; your report is saved for review.'
        : action === 'block'
          ? 'The connection and shared data were deleted for both of you. This person will not be matched with you again.'
          : 'The connection and shared data were deleted for both of you. They could appear in a future match.',
    );
  });

  const confirmCircleAction = (friendshipId: string, action: 'remove' | 'block') => {
    const isBlock = action === 'block';
    Alert.alert(
      isBlock ? 'Block and delete this connection?' : 'Remove and delete this connection?',
      'This permanently deletes your shared chat, island, photos, notes, and journal for both of you.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: isBlock ? 'Block & delete' : 'Remove & delete', style: 'destructive', onPress: () => removeCirclePerson(friendshipId, action) },
      ],
    );
  };

  const reportCirclePerson = (friendshipId: string) => Alert.alert(
    'Report and block this person?',
    'Your report will be saved for review. The connection and all shared data will be deleted for both of you, and this person will be blocked from future matches.',
    [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Harassment', onPress: () => removeCirclePerson(friendshipId, 'report', 'Harassment or hateful behavior') },
      { text: 'Privacy or unwanted pressure', onPress: () => removeCirclePerson(friendshipId, 'report', 'Privacy or unwanted pressure') },
    ],
  );

  const signOut = () => perform(async () => {
    if (token && matching) await request('/api/v1/match/queue', token, { method: 'DELETE' });
    if (token) await request('/api/v1/auth/logout', token, { method: 'POST' });
    await AsyncStorage.removeItem(TOKEN_KEY);
    socket.current?.close();
    setToken(null);
    setUser(null);
    setRoom(null);
    setMatching(false);
    setFriendships([]);
    setRoomMessages([]);
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
          <View style={styles.locationBlock}>
            <Text style={styles.label}>PRIVATE LOCATION</Text>
            <Text style={styles.body}>{latitude && longitude ? 'Location confirmed for Pune matching.' : 'Confirm you are in Pune to find a nearby companion.'}</Text>
            <Text style={styles.muted}>Your precise coordinates stay private and are only used to check eligibility and matching distance.</Text>
            <Button
              label={latitude && longitude ? 'Update my location' : 'Use my current location'}
              onPress={locateMe}
              variant="secondary"
              disabled={busy}
            />
            {__DEV__ && Platform.OS === 'android' ? (
              <Button label="Use Pune test location · development only" onPress={usePuneTestLocation} variant="quiet" disabled={busy} />
            ) : null}
          </View>
          <Text style={styles.label}>PICK A FEW VIBES</Text>
          <View style={styles.vibeList}>
            {VIBE_OPTIONS.map((vibe) => {
              const selected = vibes.includes(vibe);
              return (
                <TouchableOpacity
                  key={vibe}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  onPress={() => toggleVibe(vibe)}
                  style={[styles.vibeChip, selected && styles.vibeChipSelected]}
                >
                  <Text style={[styles.vibeText, selected && styles.vibeTextSelected]}>{vibe}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Button label={busy ? 'Saving…' : 'Save my profile'} onPress={saveProfile} disabled={busy || !latitude || !longitude || vibes.length === 0} />
          <Button label="Sign out" onPress={signOut} variant="quiet" disabled={busy} />
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      {!roomChatOpen && <View style={styles.header}>
        <View>
          <Text style={styles.eyebrow}>PARALLEL LIVES</Text>
          <Text style={styles.headerTitle}>{tab === 'room' ? activeLocation === 'home' ? 'Your little world' : activeLocation === 'tree' ? 'Memory Tree' : activeLocation === 'garden' ? 'Emotion Garden' : activeLocation === 'photos' ? 'Photos Grove' : activeLocation === 'journal' ? 'Sky Journal' : 'Milestone Bridge' : tab === 'circle' ? 'Your circle' : 'Your profile'}</Text>
        </View>
        <Text style={styles.handle}>@{user.anonymous_handle}</Text>
      </View>}
      {!!error && <TouchableOpacity onPress={() => setError('')}><Text style={styles.errorBanner}>{error}  ×</Text></TouchableOpacity>}
      {tab === 'room' && room && roomChatOpen ? (
        <KeyboardAvoidingView style={styles.chatScreen} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <View style={styles.chatTopBar}>
            <TouchableOpacity accessibilityRole="button" onPress={() => setRoomChatOpen(false)} style={styles.chatBackButton}>
              <Text style={styles.accentLink}>‹ ROOM</Text>
            </TouchableOpacity>
            <View style={styles.flex}>
              <Text style={styles.friendName}>@{room.partner?.anonymous_handle || 'your companion'}</Text>
              <Text style={styles.muted}>{partnerOnline ? 'Here now' : 'Anonymous · messages stay here'}</Text>
            </View>
            <TouchableOpacity accessibilityRole="button" onPress={reportSafetyConcern}>
              <Text style={styles.accentLink}>•••</Text>
            </TouchableOpacity>
          </View>
          <ScrollView
            ref={roomChatScrollRef}
            style={styles.chatHistory}
            contentContainerStyle={styles.chatHistoryContent}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
          >
            <Text style={styles.chatDayNotice}>DAY {room.day_streak} · YOUR CHAT IS PRIVATE</Text>
            {roomMessages.length ? roomMessages.map((message) => (
              <View key={message.id} style={[styles.whatsappBubble, message.author_id === user.id ? styles.whatsappBubbleMine : styles.whatsappBubbleTheirs]}>
                {message.author_id !== user.id ? <Text style={styles.roomMessageAuthor}>@{room.partner?.anonymous_handle || 'COMPANION'}</Text> : null}
                <Text style={styles.roomMessageContent}>{message.content}</Text>
                <Text style={styles.chatTimestamp}>{new Date(message.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</Text>
                {room.assets.some((asset) => asset.source_message_id === message.id)
                  ? <Text style={styles.savedMemoryText}>✓ Saved to Memory Tree</Text>
                  : <TouchableOpacity accessibilityRole="button" accessibilityLabel="Save this message to Memory Tree" onPress={() => saveChatMemory(message)} disabled={busy} style={styles.saveMemoryButton}><Text style={styles.saveMemoryText}>✦ Save memory</Text></TouchableOpacity>}
              </View>
            )) : (
              <View style={styles.chatEmptyHint}>
                <Text style={styles.body}>A first hello doesn’t need to be clever.</Text>
                <Text style={styles.muted}>Try asking how their day is going.</Text>
              </View>
            )}
          </ScrollView>
          <View style={styles.chatComposer}>
            <Field
              value={roomMessageText}
              onChangeText={setRoomMessageText}
              placeholder="Message"
              maxLength={1000}
              multiline={false}
              returnKeyType="send"
              style={styles.chatInput}
              onSubmitEditing={sendRoomMessage}
            />
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel="Send message"
              disabled={busy || !roomMessageText.trim()}
              onPress={sendRoomMessage}
              style={[styles.chatSendButton, (busy || !roomMessageText.trim()) && styles.buttonDisabled]}
            >
              <Text style={styles.chatSendText}>↑</Text>
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      ) : null}
      {tab === 'room' && !roomChatOpen && (
        <ScrollView ref={roomPageScrollRef} contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
          {room ? (
            <>
              {activeLocation === 'home' ? (
              <>
              <View style={styles.roomMeta}>
                <Text style={styles.pill}>DAY {room.day_streak} / {room.unmask_day_threshold}</Text>
                <Text style={styles.muted}>{room.partner?.neighborhood_tag || user.neighborhood_tag} · room {room.room_id.slice(0, 5)}</Text>
              </View>
              {room.demo_companion && <Text style={styles.demoNote}>This companion is simulated for the local MVP. Real-person matching is not enabled.</Text>}
              {room.can_rematch && <View style={styles.inactiveBanner}>
                <Text style={styles.panelTitle}>This room has been quiet</Text>
                <Text style={styles.body}>Your companion has not checked in for about {room.partner_inactive_hours} hours. You can stay, or try a new connection.</Text>
                <Button label="Leave and find someone else" onPress={leaveAndRematch} variant="secondary" disabled={busy} />
              </View>}
              <View style={styles.roomCard}>
                <View style={styles.roomCanvas}>
                  <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { transform: [
                    { translateX: treeSway.interpolate({ inputRange: [0, 1], outputRange: [-1.25, 1.25] }) },
                    { scale: 1.01 },
                  ] }]}>
                    <Image source={require('./assets/island-night.png')} resizeMode="cover" style={styles.dayIslandImage} />
                    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity: islandDayFade }]}>
                      <Image source={require('./assets/island-day-clear.png')} resizeMode="cover" style={styles.dayIslandImage} />
                    </Animated.View>
                  </Animated.View>
                  {isDaytime && <Animated.View pointerEvents="none" style={[styles.flyingBird, { transform: [
                    { translateX: birdFlight.interpolate({ inputRange: [0, 0.25, 0.5, 0.75, 1], outputRange: [-30, 48, 145, 244, 360] }) },
                    { translateY: birdFlight.interpolate({ inputRange: [0, 0.25, 0.5, 0.75, 1], outputRange: [0, -6, 2, -5, 0] }) },
                  ] }]}>
                    <BirdSilhouette flap={birdFlap} night={!isDaytime} />
                  </Animated.View>}
                  {isDaytime && <Animated.View pointerEvents="none" style={[styles.flyingBirdSecond, { transform: [
                    { translateX: birdFlightSecond.interpolate({ inputRange: [0, 0.25, 0.5, 0.75, 1], outputRange: [-45, 52, 145, 247, 360] }) },
                    { translateY: birdFlightSecond.interpolate({ inputRange: [0, 0.25, 0.5, 0.75, 1], outputRange: [0, 3, -5, 2, 0] }) },
                  ] }]}>
                    <BirdSilhouette flap={birdFlap} night={!isDaytime} small />
                  </Animated.View>}
                  <View pointerEvents="none" style={styles.waterfallGlow}>
                    <Animated.View style={[styles.waterfallStream, { opacity: waterfallFlow.interpolate({ inputRange: [0, 1], outputRange: [0.22, 0.8] }), transform: [{ translateY: waterfallFlow.interpolate({ inputRange: [0, 1], outputRange: [-5, 17] }) }] }]} />
                    <Animated.View style={[styles.waterfallStreamThin, { opacity: waterfallFlow.interpolate({ inputRange: [0, 1], outputRange: [0.12, 0.58] }), transform: [{ translateY: waterfallFlow.interpolate({ inputRange: [0, 1], outputRange: [8, 28] }) }] }]} />
                    <Animated.View style={[styles.waterfallStreamThird, { opacity: waterfallFlow.interpolate({ inputRange: [0, 1], outputRange: [0.18, 0.68] }), transform: [{ translateY: waterfallFlow.interpolate({ inputRange: [0, 1], outputRange: [18, 38] }) }] }]} />
                  </View>
                  <View pointerEvents="none" style={styles.islandTapHint}><Text style={styles.islandTapHintText}>✦  Tap a place to explore  ✦</Text></View>
                  <View style={styles.hangingPhotosArea}>
                    {[0, 1].map((frameIndex) => {
                      const frame = recentHangingPhotos[frameIndex];
                      const rotation = treeSway.interpolate({ inputRange: [0, 1], outputRange: [frameIndex === 1 ? '3deg' : '-3deg', frameIndex === 1 ? '-3deg' : '3deg'] });
                      const framePosition = [styles.hangingFrame1, styles.hangingFrame2, styles.hangingFrame3][frameIndex];
                      return <Animated.View key={frame?.id || `empty-frame-${frameIndex}`} style={[styles.hangingFrameWrap, framePosition, { transform: [{ rotate: rotation }] }]}>
                        <View style={styles.frameString} />
                        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Open Photos Grove" onPress={() => setActiveLocation('photos')} activeOpacity={0.84} style={styles.hangingPhotoFrame}>
                          {frame?.media_url ? <Image source={{ uri: frame.media_url.startsWith('/api/v1/media/') ? `${API_URL}${frame.media_url}` : frame.media_url, headers: frame.media_url.startsWith('/api/v1/media/') ? { Authorization: `Bearer ${token}` } : undefined }} style={styles.hangingPhotoImage} resizeMode="cover" /> : <View style={styles.emptyPhotoImage}><Text style={styles.emptyPhotoIcon}>{frameIndex === 1 ? '✦' : '♡'}</Text></View>}
                        </TouchableOpacity>
                      </Animated.View>;
                    })}
                    <TouchableOpacity accessibilityRole="button" accessibilityLabel="Open Photos Grove" onPress={() => setActiveLocation('photos')} style={styles.photosGroveLabel}><View style={styles.landmarkTag}><Text style={styles.landmarkLabel}>Photos Grove</Text></View></TouchableOpacity>
                  </View>
                  <TouchableOpacity accessibilityRole="button" accessibilityLabel="Open Memory Tree" onPress={() => setActiveLocation('tree')} style={styles.memoryBookPlace}>
                    <View style={styles.openBook}>
                      <View style={styles.bookPage}><Text style={styles.bookLeaf}>🌿</Text><View style={styles.bookTextLine} /></View>
                      <View style={styles.bookPage}><Text style={styles.bookLeaf}>✦</Text><View style={styles.bookTextLine} /></View>
                    </View>
                    <View style={styles.landmarkTag}><Text style={styles.landmarkLabel}>Memory Tree</Text></View>
                  </TouchableOpacity>
                  <TouchableOpacity accessibilityRole="button" accessibilityLabel="Open Emotion Garden" onPress={() => setActiveLocation('garden')} style={styles.emotionGardenPlace}>
                    <View style={styles.gardenFlowers}><Text style={styles.gardenFlower}>🌼</Text><Text style={styles.gardenFlower}>🌷</Text><Text style={styles.gardenFlower}>🌼</Text></View>
                    <View style={styles.gardenBed}><View style={styles.gardenLeaf} /><View style={styles.gardenLeaf} /><View style={styles.gardenLeaf} /></View>
                    <View style={styles.landmarkTag}><Text style={styles.landmarkLabel}>Emotion Garden</Text></View>
                  </TouchableOpacity>
                  <TouchableOpacity accessibilityRole="button" accessibilityLabel="Open Sky Journal" onPress={() => setActiveLocation('journal')} style={styles.skyJournalPlace}>
                    <View style={styles.journalPage}><Text style={styles.journalSun}>☼</Text><View style={styles.journalRule} /><View style={styles.journalRule} /><View style={styles.journalRuleShort} /></View>
                    <View style={styles.landmarkTag}><Text style={styles.landmarkLabel}>Sky Journal</Text></View>
                  </TouchableOpacity>
                  <TouchableOpacity accessibilityRole="button" accessibilityLabel="Open Milestone Bridge" onPress={() => setActiveLocation('bridge')} style={styles.milestoneBridgePlace}>
                    <View style={styles.milestoneMarker}><Text style={styles.milestoneMarkerText}>Milestones</Text></View>
                  </TouchableOpacity>
                  <TouchableOpacity accessibilityRole="button" accessibilityLabel="View polaroid in Things on your wall" onPress={() => roomPageScrollRef.current?.scrollTo({ y: wallSectionY.current, animated: true })} activeOpacity={0.85} style={styles.islandPolaroidSpot}>
                    <View style={styles.islandPolaroidFrame}>
                      {latestWallPolaroid?.media_url?.startsWith('/api/v1/media/')
                        ? <Image source={{ uri: `${API_URL}${latestWallPolaroid.media_url}`, headers: { Authorization: `Bearer ${token}` } }} style={styles.islandPolaroidThumb} resizeMode="cover" />
                        : latestWallPolaroid?.media_url ? <Image source={{ uri: latestWallPolaroid.media_url }} style={styles.islandPolaroidThumb} resizeMode="cover" />
                          : <View style={styles.islandPolaroidEmpty}><Text style={styles.islandPolaroidEmptyIcon}>✦</Text></View>}
                    </View>
                    <View style={styles.landmarkTag}><Text style={styles.landmarkLabel}>Latest Polaroid</Text></View>
                  </TouchableOpacity>
                  {room.assets.filter((asset) => asset.asset_type === 'sticky_note').slice(-1).map((asset) => (
                    <View key={asset.id} style={styles.wallNote}>
                      <Text style={styles.wallNoteQuote} numberOfLines={3}>{asset.content}</Text>
                      <Text style={styles.wallNoteAuthor}>@{asset.author_id === user.id ? user.anonymous_handle : room.partner?.anonymous_handle || 'companion'}</Text>
                    </View>
                  ))}
                  {!room.assets.some((asset) => asset.asset_type === 'sticky_note') && <View style={styles.wallNote}><Text style={styles.wallNoteQuote} numberOfLines={2}>“a place to just be”</Text><Text style={styles.wallNoteAuthor}>@{user.anonymous_handle}</Text></View>}
                  <View style={styles.beaconMarker}>
                    <View style={[styles.beaconGlow, { opacity: 0.22 + room.plant_growth.stage * 0.18, transform: [{ scale: 0.84 + room.plant_growth.stage * 0.08 }] }]} />
                    <Text style={[styles.beaconEmoji, { fontSize: BEACON_STAGES[room.plant_growth.stage]?.size || BEACON_STAGES[0].size }]}>
                      {BEACON_STAGES[room.plant_growth.stage]?.emoji || BEACON_STAGES[0].emoji}
                    </Text>
                    <View style={styles.beaconLabel}><Text style={styles.beaconTitle}>Island Beacon</Text><Text style={styles.beaconDays}>{room.plant_growth.completed_days} / 3 shared days</Text></View>
                  </View>
                </View>
                <View style={styles.statsRow}>
                  <View style={[styles.stat, styles.sharedDaysStat]}>
                    <Text style={styles.statCaption}>SHARED DAYS</Text>
                    <Text style={styles.statValue}>{room.plant_growth.completed_days} / 3</Text>
                    <View style={styles.ambienceRow}>
                      <Text style={styles.ambienceTitle}>♫ {roomSoundtrack.title}</Text>
                      <TouchableOpacity accessibilityRole="button" accessibilityLabel="Change island background music" onPress={changeRoomSoundtrack} style={styles.changeAmbienceButton}>
                        <Text style={styles.changeAmbienceText}>Change sound ↻</Text>
                      </TouchableOpacity>
                      <TouchableOpacity accessibilityRole="button" accessibilityLabel={soundEnabled ? 'Turn background music off' : 'Turn background music on'} accessibilityState={{ checked: soundEnabled }} onPress={toggleRoomSound} style={styles.soundToggleButton}>
                        <Text style={styles.soundToggleIcon}>{soundEnabled ? '🔊' : '🔇'}</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                </View>
              </View>
              <View style={styles.locationPanel}>
                <Text style={styles.panelTitle}>Explore your little world</Text>
                <Text style={styles.muted}>Every place keeps a different part of your shared story.</Text>
                <View style={styles.locationGrid}>
                  {[
                    ['tree', '🌳', 'Memory Tree'], ['garden', '🌷', 'Emotion Garden'],
                    ['photos', '🖼', 'Photos Grove'], ['journal', '☁', 'Sky Journal'],
                    ['bridge', '🌉', 'Milestone Bridge'],
                  ].map(([location, icon, label]) => (
                    <TouchableOpacity key={location} accessibilityRole="button" style={styles.locationTile} onPress={() => setActiveLocation(location as typeof activeLocation)}>
                      <Text style={styles.locationIcon}>{icon}</Text>
                      <Text style={styles.locationLabel}>{label}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
              <View style={styles.growthProgress}>
                <View style={styles.growthProgressCopy}>
                  <Text style={styles.dailyPromptEyebrow}>A LIGHT WE BUILD TOGETHER</Text>
                  <Text style={styles.muted}>{BEACON_STAGES[room.plant_growth.stage]?.detail || BEACON_STAGES[0].detail}</Text>
                </View>
                <View style={styles.growthSteps}>
                  {[1, 2, 3].map((stage) => <View key={stage} style={[styles.growthStep, room.plant_growth.completed_days >= stage && styles.growthStepComplete]} />)}
                </View>
              </View>
              <TouchableOpacity accessibilityRole="button" style={styles.roomChatPreview} onPress={() => setRoomChatOpen(true)}>
                <View style={styles.chatHeading}>
                  <View style={styles.flex}>
                    <Text style={styles.panelTitle}>Chat with @{room.partner?.anonymous_handle || 'your companion'}</Text>
                    <Text style={styles.muted} numberOfLines={1}>{roomMessages.at(-1)?.content || 'Say hello whenever you feel like it.'}</Text>
                  </View>
                  <Text style={[styles.presenceLabel, partnerOnline && styles.presenceOnline]}>{partnerOnline ? 'HERE NOW' : 'ASYNC'}</Text>
                </View>
                <Text style={styles.accentLink}>OPEN CHAT →</Text>
              </TouchableOpacity>
              <View style={styles.dailyPrompt}>
                <Text style={styles.dailyPromptEyebrow}>DAY {room.daily_prompt.day} · A SMALL RITUAL</Text>
                <Text style={styles.dailyPromptQuestion}>{room.daily_prompt.question}</Text>
                {room.daily_prompt.revealed ? (
                  <View style={styles.promptAnswers}>
                    <Text style={styles.promptAnswerLabel}>YOU</Text>
                    <Text style={styles.promptAnswerText}>{room.daily_prompt.my_answer}</Text>
                    <Text style={styles.promptAnswerLabel}>YOUR COMPANION</Text>
                    <Text style={styles.promptAnswerText}>{room.daily_prompt.partner_answer}</Text>
                  </View>
                ) : room.daily_prompt.my_answer ? (
                  <View style={styles.promptAnswers}>
                    <Text style={styles.promptAnswerLabel}>YOUR ANSWER</Text>
                    <Text style={styles.promptAnswerText}>{room.daily_prompt.my_answer}</Text>
                    <Text style={styles.muted}>It stays private until your companion replies.</Text>
                  </View>
                ) : (
                  <>
                    <Field
                      value={promptAnswer}
                      onChangeText={setPromptAnswer}
                      placeholder="Write whatever comes to mind…"
                      multiline
                      maxLength={240}
                    />
                    <Text style={styles.muted}>{promptAnswer.length}/240 · Your answer stays private until both reply.</Text>
                    <Button
                      label={busy ? 'Saving…' : 'Share today’s answer'}
                      onPress={answerDailyPrompt}
                      disabled={busy || !promptAnswer.trim()}
                    />
                  </>
                )}
              </View>
              <View style={styles.shareMoreCard}>
                <Text style={styles.dailyPromptEyebrow}>DAY 3 · CIRCLE IS A MUTUAL CHOICE</Text>
                {!room.share_more.available ? (
                  <Text style={styles.body}>Opens in {Math.max(0, 3 - room.days_elapsed)} day{3 - room.days_elapsed === 1 ? '' : 's'}. Your anonymous chat stays open meanwhile.</Text>
                ) : room.share_more.mutual ? (
                  <>
                    <Text style={styles.body}>You both chose to join each other’s Circle.</Text>
                    <View style={styles.vibeList}>{room.share_more.partner_vibe_tags.map((vibe) => <Text key={vibe} style={[styles.vibeChip, styles.vibeChipSelected]}>{vibe}</Text>)}</View>
                  </>
                ) : room.share_more.my_vote === 1 ? (
                  <Text style={styles.body}>Your choice is saved. Your companion has {shareMoreExpiryLabel} to reply. If they don’t, this island and its saved memories will be deleted.</Text>
                ) : (
                  <>
                    <Text style={styles.body}>After three days, you can choose to become friends. Your anonymous chat history comes with you; your vibe tags are shared only if you both agree.</Text>
                    <Button label="Join each other’s Circle" onPress={() => shareMore(true)} disabled={busy} />
                    <Button label="No, end this island" onPress={() => Alert.alert(
                      'End this island for both of you?',
                      'Your shared chat, notes, photos, and journal answers will be permanently deleted. This cannot be undone.',
                      [
                        { text: 'Go back', style: 'cancel' },
                        { text: 'End & delete', style: 'destructive', onPress: () => shareMore(false) },
                      ],
                    )} variant="quiet" disabled={busy} />
                  </>
                )}
              </View>
              <View style={styles.nudgeArea}>
                <Button label="Send a nudge" onPress={sendNudge} variant="secondary" disabled={busy} />
                <Text style={styles.muted}>A gentle buzz lets them know you’re around. No reply needed.</Text>
              </View>
              <View style={styles.panel}>
                <Text style={styles.panelTitle}>Leave a little note</Text>
                <Field value={note} onChangeText={setNote} placeholder="Something you noticed today…" maxLength={140} multiline />
                <Text style={styles.muted}>Add an optional feeling tag to find it later in your Emotion Garden.</Text>
                <EmotionPicker selected={assetEmotion} onSelect={setAssetEmotion} />
                <Text style={styles.muted}>{note.length}/140</Text>
                <Button label="Pin note to wall" onPress={postAsset} disabled={busy || !note.trim()} />
              </View>
              <View style={styles.panel}>
                <Text style={styles.panelTitle}>Add a polaroid</Text>
                {photoUri ? <Image source={{ uri: photoUri }} style={styles.photoPreview} /> : null}
                <Text style={styles.muted}>Photos are resized and EXIF metadata is removed. One upload per day, max 2 MB. Automated image moderation is not configured.</Text>
                <EmotionPicker selected={photoEmotion} onSelect={setPhotoEmotion} />
                <Button label={polaroidCoolingDown ? `${photoUri ? 'Choose a different photo' : 'Choose a photo'} · ${polaroidCooldownLabel}` : photoUri ? 'Choose a different photo' : 'Choose a photo'} onPress={choosePhoto} variant="quiet" disabled={busy || polaroidCoolingDown} />
                {polaroidCoolingDown ? <Text style={styles.muted}>Your next polaroid is ready in {polaroidCooldownLabel}. The 24-hour timer started after your last upload.</Text> : null}
                <Button label="Pin polaroid to wall" onPress={uploadPolaroid} disabled={busy || !photoBase64 || polaroidCoolingDown} />
              </View>
              <View style={styles.panel} onLayout={(event) => { wallSectionY.current = event.nativeEvent.layout.y; }}>
                <Text style={styles.panelTitle}>Things on your wall</Text>
                {latestWallPolaroid || latestWallNote ? <View style={styles.islandWallShelf}>
                  {latestWallPolaroid ? <View style={styles.islandPolaroid}>
                    {latestWallPolaroid.media_url?.startsWith('/api/v1/media/')
                      ? <Image source={{ uri: `${API_URL}${latestWallPolaroid.media_url}`, headers: { Authorization: `Bearer ${token}` } }} style={styles.islandPolaroidImage} />
                      : latestWallPolaroid.media_url ? <Image source={{ uri: latestWallPolaroid.media_url }} style={styles.islandPolaroidImage} /> : null}
                    <Text style={styles.islandKeepsakeCaption}>A little moment · {new Date(latestWallPolaroid.created_at).toLocaleDateString()}</Text>
                  </View> : null}
                  {latestWallNote ? <View style={styles.islandNoteCard}>
                    <Text style={styles.islandNoteLabel}>✦ A little note</Text>
                    <Text style={styles.islandNoteText}>{latestWallNote.content}</Text>
                    <Text style={styles.islandNoteAuthor}>— @{latestWallNote.author_id === user.id ? user.anonymous_handle : room.partner?.anonymous_handle}</Text>
                  </View> : null}
                </View> : <Text style={styles.muted}>The wall is waiting for its first note or polaroid.</Text>}
              </View>
              <Button label="Report a safety concern" onPress={reportSafetyConcern} variant="quiet" disabled={busy} />
              <Button label="Block and leave this room" onPress={blockPartner} variant="danger" disabled={busy} />
              <Button label="Leave this room" onPress={dissolveRoom} variant="danger" disabled={busy} />
              </>
              ) : activeLocation === 'tree' ? (
                <>
                  <View style={styles.locationHeading}><Text style={styles.locationIcon}>🌳</Text><Text style={styles.heading}>Memory Tree</Text><Text style={styles.body}>Notes, photos and saved chat moments from your shared days.</Text></View>
                  <View style={styles.panel}>
                    <Text style={styles.panelTitle}>Find a memory</Text>
                    <View style={styles.filterRow}>{(['all', 'days', 'months'] as const).map((value) => <TouchableOpacity key={value} onPress={() => setMemoryTime(value)} style={[styles.filterChip, memoryTime === value && styles.filterChipActive]}><Text style={styles.filterText}>{value === 'all' ? 'All time' : value === 'days' ? 'Last 7 days' : 'This month'}</Text></TouchableOpacity>)}</View>
                    <View style={styles.filterRow}>{(['all', 'sticky_note', 'polaroid', 'chat_memory'] as const).map((value) => <TouchableOpacity key={value} onPress={() => setMemoryType(value)} style={[styles.filterChip, memoryType === value && styles.filterChipActive]}><Text style={styles.filterText}>{value === 'all' ? 'All' : value === 'sticky_note' ? 'Notes' : value === 'polaroid' ? 'Photos' : 'Chat'}</Text></TouchableOpacity>)}</View>
                    <EmotionPicker selected={memoryEmotion} onSelect={setMemoryEmotion} />
                  </View>
                  {room.assets.filter((asset) => {
                    const created = new Date(asset.created_at);
                    const age = Date.now() - created.getTime();
                    const recent = memoryTime === 'days' ? age <= 7 * 86400000 : memoryTime === 'months' ? created.getMonth() === new Date().getMonth() && created.getFullYear() === new Date().getFullYear() : true;
                    return recent && (memoryType === 'all' || asset.asset_type === memoryType) && (!memoryEmotion || asset.emotion_tag === memoryEmotion);
                  }).slice().reverse().map((asset) => <MemoryCard key={asset.id} asset={asset} ownerId={user.id} ownerHandle={user.anonymous_handle} partnerHandle={room.partner?.anonymous_handle || 'companion'} token={token} />)}
                  {!room.assets.length && <Text style={styles.empty}>Your first shared memory is waiting to be planted.</Text>}
                  <Button label="Back to island" onPress={() => setActiveLocation('home')} variant="quiet" />
                </>
              ) : activeLocation === 'garden' ? (
                <>
                  <View style={styles.locationHeading}><Text style={styles.locationIcon}>🌷</Text><Text style={styles.heading}>Emotion Garden</Text><Text style={styles.body}>Revisit moments by how they felt. Tags are optional and can be added when you save a note or photo.</Text></View>
                  <EmotionPicker selected={memoryEmotion} onSelect={setMemoryEmotion} />
                  {room.assets.filter((asset) => asset.emotion_tag && (!memoryEmotion || asset.emotion_tag === memoryEmotion)).slice().reverse().map((asset) => <MemoryCard key={asset.id} asset={asset} ownerId={user.id} ownerHandle={user.anonymous_handle} partnerHandle={room.partner?.anonymous_handle || 'companion'} token={token} />)}
                  {!room.assets.some((asset) => asset.emotion_tag) && <Text style={styles.empty}>The garden grows when you add an emotion to a memory.</Text>}
                  <Button label="Back to island" onPress={() => setActiveLocation('home')} variant="quiet" />
                </>
              ) : activeLocation === 'photos' ? (
                <>
                  <View style={styles.locationHeading}><Text style={styles.locationIcon}>🖼</Text><Text style={styles.heading}>Photos Grove</Text><Text style={styles.body}>Little windows into the days you shared.</Text></View>
                  <View style={styles.photoGrid}>{room.assets.filter((asset) => asset.asset_type === 'polaroid').slice().reverse().map((asset) => <MemoryCard key={asset.id} asset={asset} ownerId={user.id} ownerHandle={user.anonymous_handle} partnerHandle={room.partner?.anonymous_handle || 'companion'} token={token} />)}</View>
                  {!room.assets.some((asset) => asset.asset_type === 'polaroid') && <Text style={styles.empty}>Your first polaroid will find a home here.</Text>}
                  <Button label="Back to island" onPress={() => setActiveLocation('home')} variant="quiet" />
                </>
              ) : activeLocation === 'journal' ? (
                <>
                  <View style={styles.locationHeading}><Text style={styles.locationIcon}>☁</Text><Text style={styles.heading}>Sky Journal</Text><Text style={styles.body}>Daily answers appear here once you have both shared yours.</Text></View>
                  {(room.shared_prompts || []).slice().reverse().map((prompt) => <View key={prompt.day} style={styles.journalCard}><Text style={styles.dailyPromptEyebrow}>DAY {prompt.day}</Text><Text style={styles.dailyPromptQuestion}>{prompt.question}</Text><Text style={styles.promptAnswerLabel}>YOU</Text><Text style={styles.promptAnswerText}>{prompt.my_answer}</Text><Text style={styles.promptAnswerLabel}>YOUR COMPANION</Text><Text style={styles.promptAnswerText}>{prompt.partner_answer}</Text></View>)}
                  {!(room.shared_prompts || []).length && <Text style={styles.empty}>Your shared journal will fill as you both answer daily prompts.</Text>}
                  <Button label="Back to island" onPress={() => setActiveLocation('home')} variant="quiet" />
                </>
              ) : (
                <>
                  <View style={styles.locationHeading}><Text style={styles.locationIcon}>🌉</Text><Text style={styles.heading}>Milestone Bridge</Text><Text style={styles.body}>Small firsts that mark the way you built this world.</Text></View>
                  {[
                    { icon: '✦', title: 'First conversation', detail: `Your room opened ${new Date(room.created_at).toLocaleDateString([], { day: 'numeric', month: 'short' })}` },
                    { icon: '🏮', title: 'Island beacon', detail: room.plant_growth.completed_days ? `${room.plant_growth.completed_days} shared day${room.plant_growth.completed_days === 1 ? '' : 's'} glowing` : 'Waiting for your first shared prompt' },
                    { icon: '📷', title: 'First photo', detail: room.assets.some((asset) => asset.asset_type === 'polaroid') ? 'A first polaroid is part of your story' : 'Your first photo will appear here' },
                    { icon: '♡', title: 'Mutual continuation', detail: room.share_more.mutual ? 'You both chose to keep this connection' : room.share_more.available ? 'Opens when you both feel ready' : `Available in ${Math.max(0, 3 - room.days_elapsed)} days` },
                  ].map((milestone) => <View key={milestone.title} style={styles.milestoneCard}><Text style={styles.locationIcon}>{milestone.icon}</Text><View style={styles.flex}><Text style={styles.panelTitle}>{milestone.title}</Text><Text style={styles.muted}>{milestone.detail}</Text></View></View>)}
                  <View style={styles.shareMoreCard}><Text style={styles.dailyPromptEyebrow}>CIRCLE CONNECTION</Text><Text style={styles.body}>If you both choose to continue on day 3, your private chat moves to Circle. You can reopen this world with its saved memories if you both agree within 7 days.</Text>{room.share_more.available && !room.share_more.mutual && room.share_more.my_vote !== 1 && <Button label="Choose to continue together" onPress={() => shareMore(true)} disabled={busy} />}{room.share_more.my_vote === 1 && !room.share_more.mutual && <Text style={styles.muted}>Your choice is saved. Your companion has 24 hours to reply.</Text>}{room.share_more.mutual && <Text style={styles.muted}>Your connection is ready in Circle.</Text>}</View>
                  <Button label="Back to island" onPress={() => setActiveLocation('home')} variant="quiet" />
                </>
              )}
            </>
          ) : matching ? (
            <View style={styles.searchingState}>
              <ActivityIndicator size="large" color="#76e1bd" />
              <Text style={styles.heading}>Looking for someone nearby.</Text>
              <Text style={styles.body}>We’ll keep looking for one person nearby. If no one is available right now, you can try again later.</Text>
              <Text style={styles.muted}>No simulated people are added to the queue.</Text>
                {__DEV__ && Platform.OS === 'android' ? <Button label="Use Pune test location · development only" onPress={usePuneTestLocation} variant="quiet" disabled={busy} /> : null}
              <Button label="Cancel search" onPress={cancelMatchSearch} variant="quiet" disabled={busy} />
            </View>
          ) : (
            <View style={styles.emptyState}>
              <ImageBackground source={require('./assets/island-night.png')} style={styles.islandWelcome} imageStyle={styles.islandWelcomeImage}>
                <Text style={styles.islandWelcomeEyebrow}>A LITTLE WORLD, JUST BEGINNING</Text>
                <Text style={styles.islandWelcomeTitle}>Meet someone{ '\n' }new. Grow a world.</Text>
              </ImageBackground>
              <Text style={styles.heading}>Your island is waiting.</Text>
              <Text style={styles.body}>We’ll look for one real person nearby and create a private shared island just for the two of you.</Text>
              <View style={styles.panel}>
                <Text style={styles.label}>YOUR COARSE AREA</Text>
                <Text style={styles.assetText}>{user.neighborhood_tag || 'Set your profile first'}</Text>
                <Text style={styles.muted}>Matching coordinates stay private and must be inside the Pune service area.</Text>
              </View>
              {error ? <Text style={styles.error}>{error}</Text> : null}
              <Button label={busy ? 'Finding your companion…' : 'Find a companion'} onPress={findCompanion} disabled={busy || user.latitude == null || user.longitude == null} />
              {__DEV__ && Platform.OS === 'android' ? <Button label="Use Pune test location · development only" onPress={usePuneTestLocation} variant="quiet" disabled={busy} /> : null}
            </View>
          )}
        </ScrollView>
      )}
      {tab === 'circle' && (
        <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
          <View style={styles.circleHero}>
            <View style={styles.circleHeroTop}>
              <View style={styles.circleHeroIcon}><Text style={styles.circleHeroGlyph}>✧</Text></View>
              <TouchableOpacity accessibilityRole="button" accessibilityLabel="Refresh your circle" onPress={() => token && perform(async () => loadCircle(token))} style={styles.circleRefresh} disabled={busy}>
                <Text style={styles.circleRefreshText}>{busy ? '…' : '↻'}</Text>
              </TouchableOpacity>
            </View>
            <Text style={styles.dailyPromptEyebrow}>CONNECTIONS THAT CHOSE TO STAY</Text>
            <Text style={styles.circleHeroTitle}>{friendships.length ? `${friendships.length} ${friendships.length === 1 ? 'connection' : 'connections'}` : 'One connection at a time.'}</Text>
            <Text style={styles.circleHeroBody}>Keep in touch, or choose together to reopen your world within 7 days.</Text>
          </View>
          {friendships.length > 0 && <Field value={circleSearch} onChangeText={setCircleSearch} placeholder="Search by handle or neighborhood" autoCapitalize="none" />}
          {friendships.length === 0 ? (
            <View style={styles.emptyState}>
              <View style={styles.circleEmptyIcon}><Text style={styles.circleEmptyGlyph}>☾</Text></View>
              <Text style={styles.heading}>Your circle is still quiet.</Text>
              <Text style={styles.body}>When you both choose to stay connected, your private chat and a 7-day world continuation option appear here.</Text>
              <Button label="Return to your island" onPress={() => setTab('room')} />
            </View>
          ) : (
            visibleFriendships.length ? visibleFriendships.map((friendship) => (
              <TouchableOpacity key={friendship.friendship_id} accessibilityRole="button" style={[styles.friendCard, selectedFriendship === friendship.friendship_id && styles.friendCardSelected]} onPress={() => setSelectedFriendship(friendship.friendship_id)}>
                <View style={styles.friendCardRow}>
                  <View style={styles.friendAvatar}><Text style={styles.friendAvatarText}>{friendship.anonymous_handle.slice(0, 1).toUpperCase()}</Text></View>
                  <View style={styles.flex}>
                    <Text style={styles.friendName}>@{friendship.anonymous_handle}</Text>
                    <Text style={styles.muted}>{friendship.neighborhood_tag || 'Somewhere nearby'}</Text>
                  </View>
                  <View style={styles.friendOpenPill}><Text style={styles.friendOpenText}>{selectedFriendship === friendship.friendship_id ? 'OPEN' : 'VIEW  →'}</Text></View>
                </View>
                <View style={styles.friendCardFooter}><Text style={styles.friendCardMeta}>✦  Private chat · 7-day world continuation</Text><Text style={styles.friendCardArrow}>›</Text></View>
                {friendship.verification_tier === 'demo' && <Text style={styles.demoNote}>Simulated companion · demo messages are not a real person.</Text>}
              </TouchableOpacity>
            )) : <View style={styles.emptySearch}><Text style={styles.panelTitle}>No matches in your circle</Text><Text style={styles.muted}>Try a different handle or neighborhood.</Text></View>
          )}
          {selectedFriendship && (() => {
            const connection = friendships.find((friend) => friend.friendship_id === selectedFriendship);
            if (!connection) return null;
            return (
              <View style={styles.connectionCapsule}>
                <Button label="← Back to connections" onPress={() => setSelectedFriendship(null)} variant="quiet" />
                <View style={styles.capsuleHero}>
                  <Text style={styles.dailyPromptEyebrow}>YOUR CIRCLE</Text>
                  <Text style={styles.heading}>@{connection.anonymous_handle}</Text>
                  <Text style={styles.body}>Your Circle is for staying in touch. The island and its memories stay private unless you both continue the world.</Text>
                </View>
                <View style={styles.shareMoreCard}>
                  <Text style={styles.dailyPromptEyebrow}>7-DAY WORLD CONTINUATION</Text>
                  {connection.world_active ? (
                    <Text style={styles.body}>You both agreed. Your original island and all its memories are open again.</Text>
                  ) : connection.continue_blocked ? (
                    <Text style={styles.body}>Finish your current island first. You can still continue this world while the 7-day window is open.</Text>
                  ) : connection.continue_available ? (
                    <>
                      <Text style={styles.body}>
                        {connection.my_continue_vote === 1
                          ? `Your invite is waiting. Reply by ${connection.continue_response_expires_at ? new Date(connection.continue_response_expires_at).toLocaleString() : 'within 24 hours'}.`
                          : connection.partner_continue_vote === 1
                            ? `@${connection.anonymous_handle} wants to continue this world. Say yes within 24 hours to reopen it together.`
                            : 'You both need to say yes to reopen your same island with its saved memories.'}
                      </Text>
                      {connection.my_continue_vote !== 1 && <Button label="Continue this world" onPress={() => continueSharedWorld(connection.friendship_id)} disabled={busy} />}
                      <Text style={styles.muted}>An unanswered invite expires in 24 hours.</Text>
                    </>
                  ) : (
                    <Text style={styles.muted}>The 7-day continuation window has ended.</Text>
                  )}
                </View>
                <View style={styles.panel}>
                  <Text style={styles.panelTitle}>Your conversation</Text>
                  <ScrollView ref={circleChatScrollRef} style={styles.circleMessageList} nestedScrollEnabled keyboardShouldPersistTaps="handled">
                    {messages.map((message) => (
                      <View key={message.id} style={[styles.message, message.author_id === user.id && styles.myMessage]}>
                        <Text style={styles.assetText}>{message.content}</Text>
                        <Text style={styles.chatTimestamp}>{new Date(message.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</Text>
                      </View>
                    ))}
                  </ScrollView>
                  <Field value={messageText} onChangeText={setMessageText} placeholder="Say hello…" multiline maxLength={2000} />
                  <Button label="Send message" onPress={sendMessage} disabled={busy || !messageText.trim()} />
                </View>
                <View style={styles.panel}>
                  <Text style={styles.panelTitle}>Connection controls</Text>
                  <Button label="Report and block" onPress={() => reportCirclePerson(connection.friendship_id)} variant="quiet" disabled={busy} />
                  <Button label="Block and delete shared data" onPress={() => confirmCircleAction(connection.friendship_id, 'block')} variant="danger" disabled={busy} />
                  <Button label="Remove connection and delete data" onPress={() => confirmCircleAction(connection.friendship_id, 'remove')} variant="quiet" disabled={busy} />
                </View>
              </View>
            );
          })()}
        </ScrollView>
      )}
      {tab === 'profile' && (
        <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
          <View style={styles.profileHero}>
            <View style={styles.profileAvatar}><Text style={styles.profileAvatarGlyph}>{user.anonymous_handle.slice(0, 1).toUpperCase()}</Text><View style={styles.profileAvatarStar}><Text style={styles.profileAvatarStarText}>✦</Text></View></View>
            <Text style={styles.dailyPromptEyebrow}>YOUR QUIET CORNER</Text>
            <Text style={styles.profileHandle}>@{user.anonymous_handle}</Text>
            <View style={styles.profileLocation}><Text style={styles.profileLocationIcon}>⌖</Text><Text style={styles.profileLocationText}>{user.neighborhood_tag || 'Pune'}</Text></View>
            <Text style={styles.profilePrivacyLine}>Anonymous by choice · precise location stays private</Text>
          </View>
          <View style={styles.profileStats}>
            <View style={styles.profileStat}><Text style={styles.profileStatValue}>{friendships.length}</Text><Text style={styles.profileStatLabel}>CIRCLE</Text></View>
            <View style={styles.profileStat}><Text style={styles.profileStatValue}>{room?.assets.length || 0}</Text><Text style={styles.profileStatLabel}>ISLAND MEMORIES</Text></View>
            <View style={styles.profileStat}><Text style={styles.profileStatValue}>{room?.plant_growth.completed_days || 0}</Text><Text style={styles.profileStatLabel}>SHARED DAYS</Text></View>
          </View>
          <View style={styles.profileSection}>
            <Text style={styles.dailyPromptEyebrow}>YOUR ISLAND</Text>
            <Text style={styles.profileSectionTitle}>{room ? 'A little world is growing.' : 'Your next little world is waiting.'}</Text>
            <Text style={styles.muted}>{room ? `${room.plant_growth.completed_days} shared day${room.plant_growth.completed_days === 1 ? '' : 's'} · ${room.assets.length} saved ${room.assets.length === 1 ? 'memory' : 'memories'}` : 'Meet someone new and start collecting small moments together.'}</Text>
            <Button label={room ? 'Return to my island' : 'Find a companion'} onPress={() => setTab('room')} />
            <Button label="Visit my Circle" onPress={() => setTab('circle')} variant="quiet" />
          </View>
          <View style={styles.profileSection}>
            <Text style={styles.dailyPromptEyebrow}>SOUND OF YOUR ISLAND</Text>
            <View style={styles.profileSoundRow}>
              <View style={styles.profileSoundIcon}><Text style={styles.profileSoundGlyph}>{soundEnabled ? '♫' : '♪'}</Text></View>
              <View style={styles.flex}><Text style={styles.profileSectionTitle}>{roomSoundtrack.title}</Text><Text style={styles.muted}>A soft backdrop while you explore.</Text></View>
            </View>
            <View style={styles.profileSoundActions}>
              <TouchableOpacity accessibilityRole="button" onPress={changeRoomSoundtrack} style={styles.profileSoundButton}><Text style={styles.profileSoundButtonText}>Change sound ↻</Text></TouchableOpacity>
              <TouchableOpacity accessibilityRole="button" accessibilityState={{ checked: soundEnabled }} onPress={toggleRoomSound} style={styles.profileSoundButton}><Text style={styles.profileSoundButtonText}>{soundEnabled ? 'Sound on  ◖))' : 'Sound off  ◖'}</Text></TouchableOpacity>
            </View>
          </View>
          <View style={styles.privacyCard}>
            <View style={styles.privacyIcon}><Text style={styles.privacyGlyph}>♢</Text></View>
            <View style={styles.flex}>
              <Text style={styles.profileSectionTitle}>Privacy, at your pace</Text>
              <Text style={styles.muted}>Your phone number and precise coordinates are never shown to your companion. Your anonymous handle is what they see.</Text>
            </View>
          </View>
          {room && <Button label="Delete island and all memories" onPress={dissolveRoom} variant="danger" disabled={busy} />}
          <Button label={busy ? 'Signing out…' : 'Sign out'} onPress={signOut} variant="quiet" disabled={busy} />
          <Text style={styles.demoNote}>Prototype notice: phone verification uses a local demo code; identity liveness is not configured.</Text>
        </ScrollView>
      )}
      {!roomChatOpen && <View style={styles.tabBar}>
        {(['room', 'circle', 'profile'] as const).map((item) => (
          <TouchableOpacity key={item} onPress={() => { setTab(item); if (item === 'room') setActiveLocation('home'); }} style={styles.tab}>
            <Text style={[styles.tabIcon, tab === item && styles.tabTextActive]}>{item === 'room' ? '⌂' : item === 'circle' ? '✿' : '☾'}</Text>
            <Text style={[styles.tabText, tab === item && styles.tabTextActive]}>{item === 'room' ? 'HOME' : item === 'circle' ? 'CIRCLE' : 'YOU'}</Text>
          </TouchableOpacity>
        ))}
      </View>}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  safeArea: { flex: 1, backgroundColor: '#0c1020' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0c1020' },
  page: { padding: 20, paddingBottom: 36, gap: 14 },
  authPage: { flexGrow: 1, justifyContent: 'center', padding: 24, gap: 12 },
  header: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
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
  locationBlock: { gap: 9 },
  vibeList: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  vibeChip: { minHeight: 38, justifyContent: 'center', borderRadius: 999, paddingHorizontal: 13, backgroundColor: '#202d47', borderWidth: 1, borderColor: '#35435e' },
  vibeChipSelected: { backgroundColor: '#244b43', borderColor: '#76e1bd' },
  vibeText: { color: '#c0cbe0', fontSize: 13, fontWeight: '600' },
  vibeTextSelected: { color: '#a9f0d7' },
  roomMeta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  pill: { color: '#101a28', fontSize: 11, fontWeight: '900', letterSpacing: 1, backgroundColor: '#76e1bd', borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7 },
  demoNote: { color: '#e8c98e', backgroundColor: '#392f23', borderRadius: 12, padding: 12, fontSize: 12, lineHeight: 18 },
  roomCard: { backgroundColor: '#111a30', borderColor: '#303653', borderWidth: 1, borderRadius: 22, padding: 9, shadowColor: '#7f5cff', shadowOffset: { width: 0, height: 5 }, shadowOpacity: 0.14, shadowRadius: 16, elevation: 4 },
  roomCanvas: { height: 260, overflow: 'hidden', borderRadius: 16, backgroundColor: '#10172b' },
  roomCanvasImage: { borderRadius: 16 },
  dayIslandImage: { width: '100%', height: '100%' },
  islandWelcome: { height: 248, borderRadius: 22, overflow: 'hidden', justifyContent: 'flex-end', padding: 20, marginBottom: 2 },
  islandWelcomeImage: { borderRadius: 22 },
  islandWelcomeEyebrow: { color: '#baf5e2', fontSize: 9, fontWeight: '800', letterSpacing: 1.8, textShadowColor: '#071021', textShadowRadius: 8 },
  islandWelcomeTitle: { color: '#fff7e9', fontSize: 30, lineHeight: 35, fontWeight: '800', marginTop: 8, textShadowColor: '#071021', textShadowRadius: 10 },
  wallNote: { position: 'absolute', left: 96, bottom: 16, width: 122, minHeight: 64, paddingHorizontal: 9, paddingVertical: 7, borderRadius: 13, backgroundColor: 'rgba(11, 25, 43, 0.7)', borderWidth: 1, borderColor: 'rgba(183, 217, 222, 0.46)', justifyContent: 'center', shadowColor: '#050b15', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.35, shadowRadius: 8, elevation: 4 },
  wallNoteQuote: { color: '#f6edda', fontSize: 10, lineHeight: 14, fontStyle: 'italic', textShadowColor: '#061021', textShadowRadius: 5 },
  wallNoteAuthor: { color: '#c3d9d2', fontSize: 9, fontWeight: '700', marginTop: 4 },
  photoPreview: { width: '100%', height: 210, borderRadius: 12, backgroundColor: '#202f4a' },
  islandTapHint: { position: 'absolute', left: 10, top: 9, borderRadius: 10, backgroundColor: 'rgba(9, 22, 38, 0.5)', borderWidth: 1, borderColor: 'rgba(177, 224, 213, 0.35)', paddingHorizontal: 7, paddingVertical: 3, zIndex: 5 },
  islandTapHintText: { color: '#e2f2e8', fontSize: 7, fontWeight: '800', letterSpacing: 0.25 },
  hangingPhotosArea: { position: 'absolute', left: '25%', top: '13%', width: 90, height: 78, zIndex: 4 },
  hangingFrameWrap: { position: 'absolute', width: 31, alignItems: 'center' },
  hangingFrame1: { left: 5, top: 9 },
  hangingFrame2: { left: 45, top: 1 },
  hangingFrame3: { left: 92, top: 14 },
  frameString: { width: 1, height: 8, backgroundColor: '#d8bd87', opacity: 0.8 },
  hangingPhotoFrame: { width: 29, height: 34, padding: 2, paddingBottom: 5, borderRadius: 4, backgroundColor: '#d9c8a5', borderWidth: 1, borderColor: '#ad8b57', shadowColor: '#05101a', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.4, shadowRadius: 2, elevation: 2 },
  hangingPhotoImage: { flex: 1, width: '100%', borderRadius: 2, backgroundColor: '#31515b' },
  emptyPhotoImage: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#254858', borderRadius: 2 },
  emptyPhotoIcon: { color: '#d7e9db', fontSize: 10 },
  photosGroveLabel: { position: 'absolute', left: 7, bottom: 0, alignItems: 'center' },
  landmarkTag: { borderRadius: 8, backgroundColor: 'rgba(11, 26, 38, 0.62)', borderWidth: 1, borderColor: 'rgba(186, 224, 204, 0.52)', paddingHorizontal: 5, paddingVertical: 2 },
  landmarkLabel: { color: '#f6ecd5', fontSize: 6, fontWeight: '800', textAlign: 'center', textShadowColor: '#08111c', textShadowRadius: 5 },
  landmarkTap: { color: '#a9dfcf', fontSize: 6, fontWeight: '800', textAlign: 'center' },
  memoryBookPlace: { position: 'absolute', left: '4%', top: '41%', width: 49, alignItems: 'center', zIndex: 4 },
  openBook: { flexDirection: 'row', width: 38, height: 24, borderRadius: 4, overflow: 'hidden', borderWidth: 1, borderColor: '#c6a76e', backgroundColor: '#e2d4b5', transform: [{ rotate: '-5deg' }], shadowColor: '#07101a', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.35, shadowRadius: 2, elevation: 2 },
  bookPage: { flex: 1, alignItems: 'center', justifyContent: 'center', borderRightWidth: 1, borderRightColor: '#d1bd97' },
  bookLeaf: { color: '#477853', fontSize: 10 },
  bookTextLine: { width: 9, height: 1, backgroundColor: '#b7a887', marginTop: 1 },
  emotionGardenPlace: { position: 'absolute', right: '5%', top: '50%', width: 61, alignItems: 'center', zIndex: 4 },
  gardenFlowers: { flexDirection: 'row', alignItems: 'flex-end', height: 24, gap: 0 },
  gardenFlower: { fontSize: 12, marginHorizontal: -1 },
  gardenBed: { flexDirection: 'row', justifyContent: 'center', gap: 4, width: 43, height: 6, borderRadius: 50, backgroundColor: '#374c37', borderTopWidth: 1, borderTopColor: '#7c9e62', marginTop: -2 },
  gardenLeaf: { width: 6, height: 4, borderRadius: 7, backgroundColor: '#82b86a', transform: [{ rotate: '-25deg' }] },
  skyJournalPlace: { position: 'absolute', right: '15%', top: '30%', alignItems: 'center', zIndex: 4 },
  journalPage: { width: 25, height: 27, alignItems: 'center', justifyContent: 'center', borderRadius: 4, borderWidth: 1, borderColor: '#cfb57d', backgroundColor: 'rgba(226, 212, 181, 0.88)', transform: [{ rotate: '5deg' }], shadowColor: '#07101a', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.3, shadowRadius: 2, elevation: 2 },
  journalSun: { color: '#b18b4f', fontSize: 9, lineHeight: 10 },
  journalRule: { width: 14, height: 1, backgroundColor: '#bcae90', marginTop: 2 },
  journalRuleShort: { width: 10, height: 1, backgroundColor: '#bcae90', marginTop: 2 },
  milestoneBridgePlace: { position: 'absolute', left: '43%', top: '45%', width: '24%', height: 23, alignItems: 'center', justifyContent: 'center', zIndex: 4 },
  milestoneMarker: { borderRadius: 8, backgroundColor: 'rgba(20, 37, 51, 0.62)', borderWidth: 1, borderColor: 'rgba(236, 194, 120, 0.72)', paddingHorizontal: 5, paddingVertical: 2 },
  milestoneMarkerText: { color: '#f6e6c5', fontSize: 6, fontWeight: '800' },
  islandPolaroidSpot: { position: 'absolute', right: 9, bottom: 10, width: 63, alignItems: 'center', zIndex: 5 },
  islandPolaroidFrame: { width: 45, height: 53, padding: 3, paddingBottom: 8, borderRadius: 4, backgroundColor: '#e3d2ae', borderWidth: 1, borderColor: '#b4925e', transform: [{ rotate: '4deg' }], shadowColor: '#050b15', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.5, shadowRadius: 3, elevation: 3 },
  islandPolaroidThumb: { width: '100%', flex: 1, borderRadius: 2, backgroundColor: '#233b51' },
  islandPolaroidEmpty: { flex: 1, alignItems: 'center', justifyContent: 'center', borderRadius: 2, backgroundColor: '#426174' },
  islandPolaroidEmptyIcon: { color: '#d3e8dc', fontSize: 15 },
  beaconMarker: { position: 'absolute', bottom: 10, left: 7, width: 78, alignItems: 'center', justifyContent: 'flex-end', gap: 1, zIndex: 4 },
  beaconGlow: { position: 'absolute', bottom: 27, width: 34, height: 34, borderRadius: 18, backgroundColor: '#ffd48c', shadowColor: '#ffc86b', shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.85, shadowRadius: 12, elevation: 5 },
  beaconEmoji: { lineHeight: 38, textShadowColor: 'rgba(255, 207, 116, 0.75)', textShadowRadius: 10 },
  beaconLabel: { alignItems: 'center', paddingHorizontal: 5, paddingVertical: 2, borderRadius: 8, backgroundColor: 'rgba(7, 19, 31, 0.6)', borderWidth: 1, borderColor: 'rgba(244, 207, 144, 0.55)' },
  beaconTitle: { color: '#ffedc9', fontSize: 6, fontWeight: '900' },
  beaconDays: { color: '#c3d9d2', fontSize: 5, fontWeight: '700', marginTop: 1 },
  flyingBird: { position: 'absolute', left: 0, top: 26, zIndex: 1 },
  flyingBirdSecond: { position: 'absolute', left: 0, top: 48, zIndex: 1 },
  birdShape: { width: 22, height: 17, position: 'relative' },
  birdShapeSmall: { transform: [{ scale: 0.72 }] },
  birdWing: { position: 'absolute', top: 5, width: 11, height: 4, borderRadius: 6 },
  birdWingLeft: { left: 1, transformOrigin: 'right center' },
  birdWingRight: { left: 10, transformOrigin: 'left center' },
  birdBody: { position: 'absolute', left: 9, top: 4, width: 5, height: 9, borderRadius: 4, transform: [{ rotate: '-15deg' }] },
  birdHead: { position: 'absolute', left: 10, top: 1, width: 5, height: 5, borderRadius: 3 },
  birdTail: { position: 'absolute', left: 8, top: 11, width: 0, height: 0, borderTopWidth: 5, borderLeftWidth: 3, borderRightWidth: 3, borderLeftColor: 'transparent', borderRightColor: 'transparent' },
  waterfallGlow: { position: 'absolute', left: '49%', top: '49%', width: 21, height: 56, overflow: 'hidden', borderRadius: 10 },
  waterfallStream: { position: 'absolute', left: 4, top: 0, width: 3, height: 26, borderRadius: 2, backgroundColor: 'rgba(190, 249, 255, 0.9)' },
  waterfallStreamThin: { position: 'absolute', left: 10, top: 8, width: 2, height: 24, borderRadius: 2, backgroundColor: 'rgba(225, 255, 255, 0.85)' },
  waterfallStreamThird: { position: 'absolute', left: 15, top: 18, width: 2, height: 22, borderRadius: 2, backgroundColor: 'rgba(177, 236, 250, 0.9)' },
  statsRow: { flexDirection: 'row', gap: 10, paddingTop: 12 },
  sharedDaysStat: { width: '100%' },
  stat: { flex: 1, backgroundColor: '#202f4a', borderRadius: 13, padding: 12 },
  statCaption: { color: '#9bb0d5', fontSize: 9, letterSpacing: 1.2, fontWeight: '800' },
  statValue: { color: '#f5f7ff', fontSize: 16, fontWeight: '700', marginTop: 7 },
  ambienceRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, borderTopColor: '#344660', borderTopWidth: 1, marginTop: 10, paddingTop: 9 },
  ambienceTitle: { flex: 1, color: '#c8d7e8', fontSize: 12, fontWeight: '700' },
  changeAmbienceButton: { backgroundColor: '#29465a', borderColor: '#527d83', borderWidth: 1, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 7 },
  changeAmbienceText: { color: '#c4f6e4', fontSize: 10, fontWeight: '800' },
  soundToggleButton: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center', borderRadius: 17, backgroundColor: '#29465a', borderColor: '#527d83', borderWidth: 1 },
  soundToggleIcon: { fontSize: 15 },
  panel: { backgroundColor: '#121d35', borderRadius: 16, padding: 16, gap: 10, borderWidth: 1, borderColor: '#202e49' },
  growthProgress: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  growthProgressCopy: { flex: 1, gap: 4 },
  growthSteps: { width: 76, flexDirection: 'row', gap: 4 },
  growthStep: { flex: 1, height: 5, borderRadius: 3, backgroundColor: '#293650' },
  growthStepComplete: { backgroundColor: '#76e1bd' },
  roomChat: { backgroundColor: '#121d35', borderRadius: 16, padding: 16, gap: 12, borderWidth: 1, borderColor: '#202e49' },
  roomChatPreview: { backgroundColor: '#121d35', borderRadius: 16, padding: 16, gap: 10, borderWidth: 1, borderColor: '#202e49' },
  chatScreen: { flex: 1, backgroundColor: '#0b1324' },
  chatTopBar: { minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, backgroundColor: '#152039' },
  chatBackButton: { paddingVertical: 10, paddingRight: 4 },
  chatHistory: { flex: 1 },
  circleMessageList: { maxHeight: 330 },
  chatHistoryContent: { paddingHorizontal: 16, paddingVertical: 16, gap: 10, flexGrow: 1 },
  chatDayNotice: { alignSelf: 'center', color: '#b8c7e2', backgroundColor: '#1a2943', borderRadius: 14, paddingHorizontal: 14, paddingVertical: 8, fontSize: 10, fontWeight: '700', overflow: 'hidden', marginBottom: 10 },
  whatsappBubble: { maxWidth: '86%', borderRadius: 19, paddingHorizontal: 14, paddingTop: 11, paddingBottom: 9, gap: 5, borderWidth: 1 },
  whatsappBubbleMine: { alignSelf: 'flex-end', backgroundColor: '#164b4b', borderColor: '#2c8177', borderBottomRightRadius: 6 },
  whatsappBubbleTheirs: { alignSelf: 'flex-start', backgroundColor: '#1b2942', borderColor: '#2c3d5d', borderBottomLeftRadius: 6 },
  chatTimestamp: { alignSelf: 'flex-end', color: '#9eacc7', fontSize: 10, marginTop: 3 },
  chatEmptyHint: { alignSelf: 'center', alignItems: 'center', gap: 5, backgroundColor: '#182641', borderWidth: 1, borderColor: '#2c3d5d', borderRadius: 16, padding: 16, marginTop: 22 },
  chatComposer: { flexDirection: 'row', alignItems: 'flex-end', gap: 9, paddingHorizontal: 12, paddingVertical: 10, backgroundColor: '#111d32', borderTopWidth: 1, borderTopColor: '#293955' },
  chatInput: { flex: 1, minWidth: 0, minHeight: 48, borderRadius: 24, borderColor: '#334765', backgroundColor: '#1a2942', color: '#f3f6ff', paddingHorizontal: 17, paddingVertical: 12 },
  chatSendButton: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: '#368c70' },
  chatSendText: { color: '#ffffff', fontSize: 22, fontWeight: '800', marginTop: -2 },
  nudgeArea: { alignItems: 'flex-start', gap: 7 },
  chatHeading: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  presenceLabel: { color: '#8795b2', fontSize: 9, fontWeight: '800', letterSpacing: 1 },
  presenceOnline: { color: '#9bd9c2' },
  roomMessageList: { maxHeight: 220 },
  roomMessage: { alignSelf: 'flex-start', maxWidth: '90%', backgroundColor: '#202f4a', borderRadius: 12, padding: 10, marginBottom: 7, gap: 5 },
  roomMessageMine: { alignSelf: 'flex-end', backgroundColor: '#285747' },
  roomMessageContent: { color: '#f4f6ff', fontSize: 15, lineHeight: 22 },
  roomMessageAuthor: { color: '#a9b7d6', fontSize: 8, fontWeight: '800', letterSpacing: 1 },
  shareMoreCard: { backgroundColor: '#172a35', borderRadius: 16, padding: 16, gap: 12, borderWidth: 1, borderColor: '#31504d' },
  inactiveBanner: { backgroundColor: '#392f23', borderRadius: 12, padding: 14, gap: 10 },
  accentLink: { color: '#9bd9c2', fontSize: 12, fontWeight: '700' },
  dailyPrompt: { backgroundColor: '#172a35', borderRadius: 16, padding: 16, gap: 12, borderWidth: 1, borderColor: '#31504d' },
  dailyPromptEyebrow: { color: '#9bd9c2', fontSize: 10, fontWeight: '800', letterSpacing: 1.3 },
  dailyPromptQuestion: { color: '#f3f6ff', fontSize: 20, lineHeight: 28, fontWeight: '700' },
  promptAnswers: { borderTopWidth: 1, borderTopColor: '#31504d', paddingTop: 12, gap: 7 },
  promptAnswerLabel: { color: '#9bd9c2', fontSize: 9, fontWeight: '800', letterSpacing: 1.2 },
  promptAnswerText: { color: '#f3f6ff', fontSize: 15, lineHeight: 22, marginBottom: 8 },
  panelTitle: { color: '#f3f6ff', fontSize: 17, fontWeight: '800' },
  asset: { paddingVertical: 12, borderTopColor: '#293650', borderTopWidth: 1, gap: 6 },
  assetType: { color: '#76e1bd', fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  assetText: { color: '#edf2ff', fontSize: 15, lineHeight: 21 },
  emptyState: { flex: 1, minHeight: 460, justifyContent: 'center', gap: 16 },
  searchingState: { flex: 1, minHeight: 460, justifyContent: 'center', alignItems: 'flex-start', gap: 16 },
  emptyArt: { color: '#76e1bd', fontSize: 60 },
  circleHero: { borderRadius: 23, padding: 18, gap: 9, backgroundColor: '#14283b', borderWidth: 1, borderColor: '#34535b', overflow: 'hidden' },
  circleHeroTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  circleHeroIcon: { width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center', backgroundColor: '#244b4a', borderWidth: 1, borderColor: '#5ba896' },
  circleHeroGlyph: { color: '#b9f2dc', fontSize: 28, lineHeight: 32 },
  circleRefresh: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(9, 19, 33, 0.45)', borderWidth: 1, borderColor: '#43616a' },
  circleRefreshText: { color: '#c5f3df', fontSize: 20, fontWeight: '700' },
  circleHeroTitle: { color: '#f4f1e8', fontSize: 23, lineHeight: 29, fontWeight: '800' },
  circleHeroBody: { color: '#b3c4c9', fontSize: 13, lineHeight: 19 },
  circleEmptyIcon: { width: 68, height: 68, borderRadius: 34, alignItems: 'center', justifyContent: 'center', backgroundColor: '#172840', borderWidth: 1, borderColor: '#55476f' },
  circleEmptyGlyph: { color: '#d8b9ff', fontSize: 36 },
  emptySearch: { backgroundColor: '#141e35', borderRadius: 16, padding: 16, gap: 5, borderWidth: 1, borderColor: '#303653' },
  friendCard: { backgroundColor: '#152039', borderRadius: 17, padding: 14, gap: 11, borderWidth: 1, borderColor: '#293b54' },
  friendCardSelected: { borderColor: '#68cdb0', backgroundColor: '#172b3a' },
  friendCardRow: { flexDirection: 'row', alignItems: 'center', gap: 11 },
  friendAvatar: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: '#3b3158', borderWidth: 1, borderColor: '#7c69a1' },
  friendAvatarText: { color: '#f1dfff', fontSize: 20, fontWeight: '800' },
  friendOpenPill: { borderRadius: 999, paddingHorizontal: 9, paddingVertical: 6, backgroundColor: '#20463f', borderWidth: 1, borderColor: '#3a7664' },
  friendOpenText: { color: '#b8f0da', fontSize: 8, letterSpacing: 0.6, fontWeight: '900' },
  friendCardFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 9, borderTopWidth: 1, borderTopColor: '#293650' },
  friendCardMeta: { color: '#a9b7c9', fontSize: 10, fontWeight: '600' },
  friendCardArrow: { color: '#7de2be', fontSize: 18, fontWeight: '800' },
  capsuleHero: { gap: 5, paddingVertical: 3 },
  profileHero: { alignItems: 'center', gap: 8, borderRadius: 24, padding: 20, backgroundColor: '#14283b', borderWidth: 1, borderColor: '#34535b' },
  profileAvatar: { width: 82, height: 82, borderRadius: 41, alignItems: 'center', justifyContent: 'center', backgroundColor: '#253c51', borderWidth: 2, borderColor: '#6cc9b1', marginBottom: 4 },
  profileAvatarGlyph: { color: '#ddfff0', fontSize: 34, fontWeight: '800' },
  profileAvatarStar: { position: 'absolute', right: -2, bottom: 2, width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: '#d8b9ff', borderWidth: 2, borderColor: '#14283b' },
  profileAvatarStarText: { color: '#2b2040', fontSize: 12, fontWeight: '900' },
  profileHandle: { color: '#f4f1e8', fontSize: 23, fontWeight: '800' },
  profileLocation: { flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5, backgroundColor: 'rgba(31, 67, 66, 0.7)' },
  profileLocationIcon: { color: '#a5e3ca', fontSize: 13 },
  profileLocationText: { color: '#c3eddb', fontSize: 11, fontWeight: '700' },
  profilePrivacyLine: { color: '#a9b8c6', fontSize: 10, textAlign: 'center', marginTop: 2 },
  profileStats: { flexDirection: 'row', gap: 8 },
  profileStat: { flex: 1, minHeight: 72, alignItems: 'center', justifyContent: 'center', gap: 3, borderRadius: 15, backgroundColor: '#17233b', borderWidth: 1, borderColor: '#2c3a54', padding: 6 },
  profileStatValue: { color: '#d9c7ff', fontSize: 22, fontWeight: '900' },
  profileStatLabel: { color: '#9ba9c2', fontSize: 7, letterSpacing: 0.55, fontWeight: '800', textAlign: 'center' },
  profileSection: { borderRadius: 18, padding: 15, gap: 10, backgroundColor: '#131e34', borderWidth: 1, borderColor: '#2c3a54' },
  profileSectionTitle: { color: '#f0f2f8', fontSize: 15, lineHeight: 20, fontWeight: '800' },
  profileSoundRow: { flexDirection: 'row', alignItems: 'center', gap: 11 },
  profileSoundIcon: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: '#25483f', borderWidth: 1, borderColor: '#4e907c' },
  profileSoundGlyph: { color: '#baf1d8', fontSize: 21, fontWeight: '800' },
  profileSoundActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  profileSoundButton: { minHeight: 35, justifyContent: 'center', borderRadius: 999, paddingHorizontal: 12, backgroundColor: '#202d47', borderWidth: 1, borderColor: '#394962' },
  profileSoundButtonText: { color: '#c7f1df', fontSize: 10, fontWeight: '800' },
  privacyCard: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, borderRadius: 18, padding: 15, backgroundColor: '#17263a', borderWidth: 1, borderColor: '#344b5a' },
  privacyIcon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: '#263e55' },
  privacyGlyph: { color: '#bcebd9', fontSize: 23 },
  friendName: { color: '#f3f6ff', fontSize: 17, fontWeight: '800' },
  message: { backgroundColor: '#202f4a', borderRadius: 12, padding: 12, gap: 5, alignSelf: 'flex-start', maxWidth: '90%' },
  myMessage: { backgroundColor: '#285747', alignSelf: 'flex-end' },
  tabBar: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: '#272b49', backgroundColor: '#0c1020', paddingBottom: Platform.OS === 'ios' ? 4 : 0 },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 8, gap: 2 },
  tabIcon: { color: '#77839a', fontSize: 20, lineHeight: 22 },
  tabText: { color: '#77839a', fontSize: 9, fontWeight: '800', letterSpacing: 1.2 },
  tabTextActive: { color: '#76e1bd' },
  locationPanel: { backgroundColor: '#111a30', borderRadius: 20, padding: 16, gap: 12, borderWidth: 1, borderColor: '#383657' },
  locationGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 9 },
  locationTile: { width: '31%', minHeight: 88, borderRadius: 16, borderWidth: 1, borderColor: '#343653', backgroundColor: '#171d35', alignItems: 'center', justifyContent: 'center', gap: 6, padding: 8 },
  locationIcon: { fontSize: 29, lineHeight: 36 },
  locationLabel: { color: '#e8e9f7', fontSize: 10, fontWeight: '700', textAlign: 'center' },
  locationHeading: { alignItems: 'center', gap: 6, paddingVertical: 9 },
  filterRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  filterChip: { borderWidth: 1, borderColor: '#343d5b', backgroundColor: '#18233b', borderRadius: 999, paddingHorizontal: 11, paddingVertical: 8 },
  filterChipActive: { backgroundColor: '#3c315e', borderColor: '#c8a9ff' },
  filterText: { color: '#e9e4fb', fontSize: 11, fontWeight: '700' },
  emotionPicker: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  emotionChip: { borderWidth: 1, borderColor: '#39415f', backgroundColor: '#1a2239', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 7 },
  emotionChipActive: { backgroundColor: '#44345f', borderColor: '#d2adff' },
  emotionText: { color: '#eee8ff', fontSize: 11, fontWeight: '700' },
  memoryCard: { backgroundColor: '#131d34', borderRadius: 17, borderWidth: 1, borderColor: '#303653', padding: 14, gap: 10 },
  memoryCardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  memoryEmotion: { color: '#e7c9ff', fontSize: 10, textTransform: 'capitalize', backgroundColor: '#38284d', borderRadius: 999, paddingHorizontal: 9, paddingVertical: 5 },
  memoryImage: { width: '100%', height: 190, borderRadius: 12, backgroundColor: '#202f4a' },
  photoGrid: { gap: 10 },
  journalCard: { backgroundColor: '#141e35', borderWidth: 1, borderColor: '#343653', borderRadius: 17, padding: 15, gap: 8 },
  milestoneCard: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 15, backgroundColor: '#141e35', borderWidth: 1, borderColor: '#303653', padding: 14 },
  connectionCapsule: { backgroundColor: '#111a30', borderWidth: 1, borderColor: '#59447a', borderRadius: 20, padding: 16, gap: 12 },
  saveMemoryButton: { alignSelf: 'flex-start', marginTop: 7, minHeight: 34, justifyContent: 'center', paddingHorizontal: 12, paddingVertical: 7, borderRadius: 17, backgroundColor: '#213b51', borderWidth: 1, borderColor: '#4f8092' },
  saveMemoryText: { color: '#c4f6e4', fontSize: 12, fontWeight: '800' },
  savedMemoryText: { alignSelf: 'flex-start', marginTop: 7, color: '#9debd0', fontSize: 11, fontWeight: '700' },
  islandWallShelf: { gap: 12, padding: 10, borderRadius: 18, backgroundColor: '#20354a', borderWidth: 1, borderColor: '#796748' },
  islandPolaroid: { padding: 8, borderRadius: 12, backgroundColor: '#f2e5c9', borderWidth: 2, borderColor: '#b59460', transform: [{ rotate: '-1deg' }] },
  islandPolaroidImage: { width: '100%', height: 165, borderRadius: 7, backgroundColor: '#233b51' },
  islandKeepsakeCaption: { color: '#55452f', fontSize: 11, fontWeight: '700', textAlign: 'center', paddingTop: 7, paddingBottom: 2 },
  islandNoteCard: { padding: 14, borderRadius: 14, backgroundColor: '#f3e3b7', borderWidth: 1, borderColor: '#c59b5d', gap: 7 },
  islandNoteLabel: { color: '#765b36', fontSize: 10, fontWeight: '800', letterSpacing: 0.5 },
  islandNoteText: { color: '#3f3528', fontSize: 15, lineHeight: 22 },
  islandNoteAuthor: { color: '#765b36', fontSize: 11, fontWeight: '700', textAlign: 'right' },
  empty: { color: '#96a5c3', fontSize: 13, lineHeight: 20, textAlign: 'center', padding: 20 },
});
