import React, { useEffect, useState, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { initializeApp } from 'firebase/app';
import { getDatabase, ref, push, set, onValue, remove, update } from 'firebase/database';

// --- Firebase Configuration ---
const firebaseConfig = {
    apiKey: "AIzaSyDeu4lRYAmlxb4FLC9sNaj9GwgpmZ5T5Co",
    authDomain: "our-music-player.firebaseapp.com",
    databaseURL: "https://our-music-player-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "our-music-player",
    storageBucket: "our-music-player.firebasestorage.app",
    messagingSenderId: "444208622552",
    appId: "1:444208622552:web:839ca00a5797f52d1660ad",
    measurementId: "G-B4GFLNFCLL"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

const syncRef = ref(db, 'sync');
const queueRef = ref(db, 'queue');
const chatRef = ref(db, 'chat');

const YOUTUBE_API_KEY = "AIzaSyDInaN1IfgD6VqMLLY7Wh1DbyKd6kcDi68";

// --- Components ---
const GlassPanel = ({ children, className = "" }) => (
  <div className={`glass-panel rounded-3xl ${className}`}>
    {children}
  </div>
);

const App = () => {
  // --- State ---
  const [player, setPlayer] = useState(null);
  const [queue, setQueue] = useState([]);
  const [currentVideoId, setCurrentVideoId] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [activeTab, setActiveTab] = useState('queue');
  const [chatMessages, setChatMessages] = useState([]);
  const [searchResults, setSearchResults] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [myName, setMyName] = useState('Guest');
  const [syncStatus, setSyncStatus] = useState('Synced');
  const [isAdStall, setIsAdStall] = useState(false);

  const lastBroadcaster = useRef("System");
  const isRemoteUpdate = useRef(false);
  const chatEndRef = useRef(null);

  // --- Initialization ---
  useEffect(() => {
    let name = localStorage.getItem('deepSpaceUserName');
    if (!name) {
      name = "Sarthak"; 
      localStorage.setItem('deepSpaceUserName', name);
    }
    setMyName(name);

    // Load Youtube API
    if (!window.YT) {
      const tag = document.createElement('script');
      tag.src = "https://www.youtube.com/iframe_api";
      const firstScriptTag = document.getElementsByTagName('script')[0];
      firstScriptTag.parentNode?.insertBefore(tag, firstScriptTag);
    }

    window.onYouTubeIframeAPIReady = () => {
      new window.YT.Player('youtube-player', {
        height: '100%',
        width: '100%',
        videoId: '',
        playerVars: {
          'controls': 0,
          'disablekb': 0,
          'rel': 0,
          'modestbranding': 1,
          'autoplay': 0,
          'origin': window.location.origin
        },
        events: {
          'onReady': (event) => {
            setPlayer(event.target);
            event.target.setVolume(85);
          },
          'onStateChange': onPlayerStateChange
        }
      });
    };
  }, []);

  // --- Firebase Listeners ---
  useEffect(() => {
    // Queue Listener
    const queueUnsub = onValue(queueRef, (snapshot) => {
      const data = snapshot.val();
      const list = [];
      if (data) {
        Object.keys(data).forEach(key => list.push({ ...data[key], key }));
      }
      list.sort((a, b) => a.order - b.order);
      setQueue(list);
    });

    // Chat Listener
    const chatUnsub = onValue(chatRef, (snapshot) => {
      const data = snapshot.val();
      const list = [];
      if (data) {
        Object.keys(data).forEach(key => list.push({ ...data[key], key }));
      }
      setChatMessages(list.slice(-50));
    });

    // Sync Listener
    const syncUnsub = onValue(syncRef, (snapshot) => {
      const state = snapshot.val();
      if (state) {
        lastBroadcaster.current = state.lastUpdater;
        
        if (state.lastUpdater !== myName && player) {
            isRemoteUpdate.current = true;
            
            // Handle Ad Stall
            if (state.isAdStall && state.action !== 'play') {
                setIsAdStall(true);
                setSyncStatus('Stalled');
                player.pauseVideo();
            } else {
                setIsAdStall(false);
                
                // Video Change
                if (state.videoId !== currentVideoId) {
                    setCurrentVideoId(state.videoId);
                    player.loadVideoById(state.videoId);
                }

                // Time Sync
                const currentTime = player.getCurrentTime();
                if (Math.abs(currentTime - state.time) > 2) {
                    player.seekTo(state.time, true);
                }

                // Play/Pause
                if (state.action === 'play') {
                    player.playVideo();
                    setIsPlaying(true);
                    setSyncStatus('Synced');
                } else {
                    player.pauseVideo();
                    setIsPlaying(false);
                    setSyncStatus('Paused');
                }
            }
            
            setTimeout(() => { isRemoteUpdate.current = false; }, 1000);
        }
      }
    });

    return () => {
      queueUnsub();
      chatUnsub();
      syncUnsub();
    };
  }, [myName, player, currentVideoId]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  // --- Logic Functions ---

  const onPlayerStateChange = (event) => {
    if (!player) return;
    const state = event.data;

    // YT.PlayerState.PLAYING = 1, PAUSED = 2, BUFFERING = 3, ENDED = 0
    if (state === 1) { // Playing
        setIsPlaying(true);
        setIsAdStall(false);
        setSyncStatus('Synced');
        if (!isRemoteUpdate.current) broadcastState('play', player.getCurrentTime(), currentVideoId || '', false);
    } else if (state === 2) { // Paused
        setIsPlaying(false);
        setSyncStatus('Paused');
        if (!isRemoteUpdate.current) broadcastState('pause', player.getCurrentTime(), currentVideoId || '', false);
    } else if (state === 0) { // Ended
        playNextSong();
    }
  };

  const broadcastState = (action, time, videoId, isAdStallVal) => {
    const payload = {
        action,
        time,
        videoId,
        isAdStall: isAdStallVal,
        lastUpdater: myName,
        timestamp: Date.now()
    };
    set(syncRef, payload);
  };

  const playNextSong = () => {
    if (queue.length === 0) return;
    const currentIdx = queue.findIndex(s => s.videoId === currentVideoId);
    const nextIdx = (currentIdx + 1) % queue.length;
    const nextSong = queue[nextIdx];
    
    if (nextSong) {
        loadAndPlay(nextSong);
    }
  };

  const playPrevSong = () => {
    if (queue.length === 0) return;
    const currentIdx = queue.findIndex(s => s.videoId === currentVideoId);
    const prevIdx = (currentIdx - 1 + queue.length) % queue.length;
    const prevSong = queue[prevIdx];
    if (prevSong) loadAndPlay(prevSong);
  };

  const loadAndPlay = (song) => {
    setCurrentVideoId(song.videoId);
    if (player) {
        player.loadVideoById(song.videoId);
        player.playVideo();
        broadcastState('play', 0, song.videoId, false);
    }
  };

  const togglePlay = () => {
    if (!player) return;
    if (isPlaying) {
        player.pauseVideo();
    } else {
        player.playVideo();
    }
  };

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setActiveTab('results');
    
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(searchQuery)}&type=video&maxResults=10&key=${YOUTUBE_API_KEY}`;
    
    try {
        const res = await fetch(url);
        const data = await res.json();
        if (data.items) {
            const results = data.items.map((item) => ({
                videoId: item.id.videoId,
                title: item.snippet.title,
                uploader: item.snippet.channelTitle,
                thumbnail: item.snippet.thumbnails.default.url,
                order: 0
            }));
            setSearchResults(results);
        }
    } catch (e) {
        console.error(e);
    }
    setSearchQuery('');
  };

  const addToQueue = (song) => {
    const newRef = push(queueRef);
    set(newRef, { ...song, order: Date.now() });
    setActiveTab('queue');
    if (!currentVideoId) {
        loadAndPlay(song);
    }
  };

  const removeFromQueue = (key, e) => {
    e.stopPropagation();
    remove(ref(db, `queue/${key}`));
  };

  const clearQueue = () => {
    if(window.confirm("Clear the queue?")) {
        remove(queueRef);
    }
  };

  const sendMessage = () => {
    const input = document.getElementById('chatInput');
    const text = input.value.trim();
    if (text) {
        push(chatRef, { user: myName, text, timestamp: Date.now() });
        input.value = '';
    }
  };

  const getCurrentSongDetails = () => {
    const song = queue.find(s => s.videoId === currentVideoId);
    return song || { title: "Select a song...", uploader: "" };
  };

  const currentSong = getCurrentSongDetails();
  const nextUpIndex = queue.findIndex(s => s.videoId === currentVideoId) + 1;
  const nextUpList = queue.slice(nextUpIndex).concat(queue.slice(0, nextUpIndex)).slice(0, 50);

  return (
    <div className="relative w-full h-full flex flex-col justify-center items-center p-4">
        {/* Animated Background Blobs */}
        <div className="liquid-blob bg-[#ff0a78] w-[50vw] h-[50vw] -top-[10%] -left-[10%]"></div>
        <div className="liquid-blob bg-[#240b36] w-[60vw] h-[60vw] -bottom-[10%] -right-[10%] animation-delay-2000"></div>
        <div className="liquid-blob bg-[#00f2ea] w-[30vw] h-[30vw] top-[40%] left-[40%] opacity-30 animation-delay-4000"></div>

        {/* Main App Container */}
        <div className="w-full max-w-[1600px] h-[95vh] flex flex-col gap-5 z-10">
            
            {/* Header */}
            <GlassPanel className="flex justify-between items-center px-8 py-4 shrink-0">
                <div className="text-3xl font-cursive bg-gradient-to-r from-white to-pink-300 bg-clip-text text-transparent">
                    Sarthak <i className="fa-solid fa-heart text-primary animate-pulse mx-2"></i> Reechita's Heart's Rhythm
                </div>
                <button className="text-gray-400 hover:text-white text-xl transition-colors">
                    <i className="fa-solid fa-circle-info"></i>
                </button>
            </GlassPanel>

            <div className="flex flex-col lg:flex-row gap-6 flex-1 overflow-hidden">
                {/* Left Column: Player */}
                <GlassPanel className="flex-[2] min-w-0 p-8 flex flex-col relative overflow-hidden">
                    <div className="relative w-full pb-[56.25%] bg-black rounded-2xl overflow-hidden shadow-2xl border border-white/5 mb-6">
                        <div id="youtube-player" className="absolute top-0 left-0 w-full h-full" />
                        {isAdStall && (
                             <div className="absolute inset-0 bg-black/80 flex flex-col items-center justify-center z-50 backdrop-blur-sm">
                                <div className="animate-spin rounded-full h-12 w-12 border-t-4 border-primary border-r-transparent mb-4"></div>
                                <p className="text-primary-soft font-semibold">Partner is watching an Ad...</p>
                             </div>
                        )}
                    </div>

                    <div className="text-center mb-auto">
                        <h2 className="text-2xl font-bold text-white mb-2 truncate px-4">
                            {currentSong.title}
                        </h2>
                        <div className="flex items-center justify-center gap-2 text-sm font-medium tracking-widest text-primary-soft uppercase">
                            {syncStatus === 'Synced' ? <i className="fa-solid fa-wifi"></i> : <i className="fa-solid fa-pause"></i>}
                            <span>{syncStatus === 'Synced' ? 'Connected' : 'Paused by You'}</span>
                        </div>
                        {currentSong.uploader && <p className="mt-2 text-gray-400 text-sm">S@rth@k ;)</p>}
                    </div>

                    <div className="flex justify-center items-center gap-8 mt-6">
                        <button onClick={playPrevSong} className="w-12 h-12 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white transition-all active:scale-95">
                            <i className="fa-solid fa-backward-step"></i>
                        </button>
                        <button onClick={togglePlay} className="w-20 h-20 rounded-full bg-primary hover:bg-[#d60060] shadow-[0_0_30px_rgba(255,10,120,0.5)] flex items-center justify-center text-white text-3xl transition-transform active:scale-95">
                            {isPlaying ? <i className="fa-solid fa-pause"></i> : <i className="fa-solid fa-play ml-1"></i>}
                        </button>
                        <button onClick={playNextSong} className="w-12 h-12 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white transition-all active:scale-95">
                            <i className="fa-solid fa-forward-step"></i>
                        </button>
                    </div>
                </GlassPanel>

                {/* Right Column: Sidebar */}
                <div className="flex-1 min-w-[380px] flex flex-col gap-4">
                    <GlassPanel className="flex-1 flex flex-col overflow-hidden">
                        {/* Search Bar */}
                        <div className="p-5 pb-0 flex gap-2">
                            <div className="flex-1 bg-black/30 rounded-lg flex items-center border border-white/5 px-4">
                                <i className="fa-solid fa-magnifying-glass text-gray-400 mr-3"></i>
                                <input 
                                    type="text" 
                                    className="bg-transparent w-full py-3 text-sm focus:outline-none font-sans"
                                    placeholder="Search or paste link..."
                                    value={searchQuery}
                                    onChange={(e) => setSearchQuery(e.target.value)}
                                    onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                                />
                            </div>
                        </div>

                        {/* Tabs */}
                        <div className="flex px-6 mt-4 border-b border-white/5">
                            <button 
                                onClick={() => setActiveTab('queue')}
                                className={`pb-3 px-4 text-sm font-bold tracking-wide transition-colors relative ${activeTab === 'queue' ? 'text-white' : 'text-gray-500 hover:text-gray-300'}`}
                            >
                                QUEUE <span className="bg-primary text-[10px] px-1.5 py-0.5 rounded ml-1">{queue.length}</span>
                                {activeTab === 'queue' && <div className="absolute bottom-0 left-0 w-full h-0.5 bg-primary shadow-[0_0_10px_#ff0a78]"></div>}
                            </button>
                            <button 
                                onClick={() => setActiveTab('results')}
                                className={`pb-3 px-4 text-sm font-bold tracking-wide transition-colors relative ${activeTab === 'results' ? 'text-white' : 'text-gray-500 hover:text-gray-300'}`}
                            >
                                RESULTS
                                {activeTab === 'results' && <div className="absolute bottom-0 left-0 w-full h-0.5 bg-primary shadow-[0_0_10px_#ff0a78]"></div>}
                            </button>
                            <button 
                                onClick={() => setActiveTab('chat')}
                                className={`pb-3 px-4 text-sm font-bold tracking-wide transition-colors relative ${activeTab === 'chat' ? 'text-white' : 'text-gray-500 hover:text-gray-300'}`}
                            >
                                CHAT
                                {activeTab === 'chat' && <div className="absolute bottom-0 left-0 w-full h-0.5 bg-primary shadow-[0_0_10px_#ff0a78]"></div>}
                            </button>
                        </div>

                        {/* Content Area */}
                        <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
                            
                            {activeTab === 'queue' && (
                                <>
                                    <div className="flex justify-between items-center mb-4 px-2">
                                        <h3 className="text-lg font-bold">Up Next</h3>
                                        <button onClick={clearQueue} className="text-xs bg-red-500/20 text-red-400 px-3 py-1 rounded hover:bg-red-500/40 transition-colors">
                                            Clear All
                                        </button>
                                    </div>
                                    <div className="space-y-2">
                                        {nextUpList.map((song, idx) => (
                                            <div 
                                                key={song.key || idx} 
                                                onClick={() => loadAndPlay(song)}
                                                className={`group flex items-center p-3 rounded-xl transition-all cursor-pointer border border-transparent hover:bg-white/5 ${song.videoId === currentVideoId ? 'bg-gradient-to-r from-primary/20 to-transparent border-l-primary border-l-4' : 'bg-white/5'}`}
                                            >
                                                <span className="w-8 text-center text-gray-500 font-bold text-sm">{idx + 1}</span>
                                                <img src={song.thumbnail} alt="thumb" className="w-10 h-10 rounded-md object-cover mr-3" />
                                                <div className="flex-1 min-w-0">
                                                    <h4 className={`text-sm font-semibold truncate ${song.videoId === currentVideoId ? 'text-primary-soft' : 'text-white'}`}>{song.title}</h4>
                                                    <p className="text-xs text-gray-500 truncate">{song.uploader}</p>
                                                </div>
                                                <button onClick={(e) => song.key && removeFromQueue(song.key, e)} className="w-8 h-8 flex items-center justify-center text-gray-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity">
                                                    <i className="fa-solid fa-trash"></i>
                                                </button>
                                            </div>
                                        ))}
                                        {queue.length === 0 && <div className="text-center text-gray-500 mt-10">Queue is empty.</div>}
                                    </div>
                                </>
                            )}

                            {activeTab === 'results' && (
                                <div className="space-y-2">
                                    {searchResults.map((song) => (
                                        <div key={song.videoId} className="flex items-center p-3 rounded-xl bg-white/5 hover:bg-white/10 transition-colors cursor-pointer" onClick={() => addToQueue(song)}>
                                            <img src={song.thumbnail} alt="thumb" className="w-12 h-12 rounded-md object-cover mr-3" />
                                            <div className="flex-1 min-w-0">
                                                <h4 className="text-sm font-semibold text-white truncate">{song.title}</h4>
                                                <p className="text-xs text-gray-500 truncate">{song.uploader}</p>
                                            </div>
                                            <button className="text-primary hover:text-white transition-colors p-2">
                                                <i className="fa-solid fa-plus"></i>
                                            </button>
                                        </div>
                                    ))}
                                    {searchResults.length === 0 && <div className="text-center text-gray-500 mt-10">Search for songs to add.</div>}
                                </div>
                            )}

                            {activeTab === 'chat' && (
                                <div className="flex flex-col h-full">
                                    <div className="flex-1 space-y-4 mb-4">
                                        {chatMessages.map((msg, i) => {
                                            const isMe = msg.user === myName;
                                            return (
                                                <div key={i} className={`flex flex-col ${isMe ? 'items-end' : 'items-start'}`}>
                                                    <div className={`max-w-[85%] px-4 py-2 rounded-2xl text-sm ${isMe ? 'bg-gradient-to-br from-primary to-pink-500 text-white rounded-br-sm' : 'bg-white/10 text-white rounded-bl-sm'}`}>
                                                        {msg.text}
                                                    </div>
                                                    <span className="text-[10px] text-gray-500 mt-1 px-1">{msg.user}</span>
                                                </div>
                                            )
                                        })}
                                        <div ref={chatEndRef} />
                                    </div>
                                    <div className="flex gap-2 mt-auto">
                                        <input 
                                            id="chatInput"
                                            className="flex-1 bg-black/30 border border-white/10 rounded-full px-4 py-2 text-sm focus:outline-none focus:border-primary/50"
                                            placeholder="Type something sweet..."
                                            onKeyDown={(e) => e.key === 'Enter' && sendMessage()}
                                        />
                                        <button onClick={sendMessage} className="w-10 h-10 rounded-full bg-primary flex items-center justify-center text-white hover:bg-pink-600 transition-colors">
                                            <i className="fa-solid fa-paper-plane text-xs"></i>
                                        </button>
                                    </div>
                                </div>
                            )}

                        </div>
                    </GlassPanel>
                </div>
            </div>
        </div>
    </div>
  );
};

// Render logic
const rootElement = document.getElementById('root');
const root = createRoot(rootElement);
root.render(<App />);
