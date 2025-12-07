// --- CONFIGURATION ---
// IMPORTANT: Update your Firebase Config and YouTube API Key here!
const firebaseConfig = {
    apiKey: "AIzaSyDeu4lRYAmlxb4FLC9sNaj9GwgpmZ5T5Co", // YOUR FIREBASE API KEY
    authDomain: "our-music-player.firebaseapp.com",
    databaseURL: "https://our-music-player-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "our-music-player",
    storageBucket: "our-music-player.firebasestorage.app",
    messagingSenderId: "444208622552",
    appId: "1:444208622552:web:839ca00a5797f52d1660ad",
    measurementId: "G-B4GFLNFCLL"
};
const YOUTUBE_API_KEY = "AIzaSyDInaN1IfgD6VqMLLY7Wh1DbyKd6kcDi68"; // YOUR YOUTUBE API KEY

// Initialize Firebase
if (typeof firebase !== 'undefined' && !firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
}
const db = firebase.database();

// --- USER IDENTIFICATION ---
let myName = "Sarthak"; 
const storedName = localStorage.getItem('deepSpaceUserName');
if (storedName) {
    myName = storedName;
} else {
    const enteredName = prompt("Welcome to Deep Space Sync! Please enter your name (Sarthak or Reechita):");
    if (enteredName && enteredName.trim() !== "") {
        myName = enteredName.trim();
        localStorage.setItem('deepSpaceUserName', myName);
    }
}

// CRITICAL FIX: Ensure DB paths are consistently Sarthak/Reechita regardless of input casing
const fixedDBName = (myName.toLowerCase().includes("sarthak")) ? "Sarthak" : "Reechita"; 
const fixedPartnerName = (fixedDBName === "Sarthak") ? "Reechita" : "Sarthak";

// --- DATABASE REFERENCES ---
const queueRef = db.ref('queue'); 
const mySyncRef = db.ref(`users/${fixedDBName}/sync`);
const myChatRef = db.ref(`users/${fixedDBName}/chat`);
const partnerSyncRef = db.ref(`users/${fixedPartnerName}/sync`);
const partnerChatRef = db.ref(`users/${fixedPartnerName}/chat`); // Partner's chat path

const partnerDisplayLabel = fixedPartnerName; 

// --- GLOBAL STATE ---
let player; 
let currentQueue = [];
let currentSearchResults = [];
let currentVideoId = null;
let lastBroadcaster = "System";
let isManualAction = false; 
let isPartnerPlaying = false; 
let lastSyncState = null; 
let lastLocalActionTime = 0; // Timestamp of the last local play/pause action
let lastSentTime = 0; // NEW: For ad/stall detection
let timeStagnantCount = 0; // NEW: Counter for how many seconds the time hasn't changed

// ------------------------------------------------------------------------------------------------------
// --- YOUTUBE PLAYER FUNCTIONS ---
// ------------------------------------------------------------------------------------------------------

function onYouTubeIframeAPIReady() {
    player = new YT.Player('player', {
        height: '100%',
        width: '100%',
        videoId: '', 
        playerVars: {
            'controls': 1,           
            'disablekb': 0, 
            'rel': 0,
            'showinfo': 0,
            'modestbranding': 1,
            'autoplay': 0,
            'origin': window.location.origin
        },
        events: {
            'onReady': onPlayerReady, 
            'onStateChange': onPlayerStateChange
        }
    });
}

function onPlayerReady(event) {
    if (player && player.setVolume) {
        player.setVolume(70); 
    }
    
    // Initialize lastSentTime
    lastSentTime = player.getCurrentTime ? player.getCurrentTime() : 0;
    
    // Time broadcast interval (for sync and stall detection)
    setInterval(broadcastTimeIfPlaying, 1000); 
    loadInitialData(); 
}

// FIX: Implement time stagnation detection for ads/buffers
function broadcastTimeIfPlaying() {
    if (player && player.getPlayerState && currentVideoId) {
        const state = player.getPlayerState();
        const currentTime = player.getCurrentTime();
        const duration = player.getDuration();
        
        // Handle song end locally
        if (state === YT.PlayerState.PLAYING && duration - currentTime < 1 && duration > 0) {
            playNextSong();
            return; 
        }

        let isAdStall = false;
        
        // NEW STALL DETECTION LOGIC: Check if player is in 'PLAYING' state but time isn't progressing
        if (state === YT.PlayerState.PLAYING) {
             // Check for time stagnation (less than 0.1s progression)
             if (Math.abs(currentTime - lastSentTime) < 0.1) {
                timeStagnantCount++;
            } else {
                timeStagnantCount = 0;
            }
            
            // If stagnant for 3 consecutive 1-second intervals, it's a stall
            if (timeStagnantCount >= 3) { 
                isAdStall = true;
            }
        } else {
            // Reset count if not playing
            timeStagnantCount = 0;
        }
        
        lastSentTime = currentTime; // Update last sent time

        // Only broadcast if we are currently playing/stalled AND we were the one who initiated play
        if ((state === YT.PlayerState.PLAYING || isAdStall) && lastBroadcaster === fixedDBName) {
            // Action is 'pause' if stalled, otherwise 'play'
            const action = isAdStall ? 'pause' : 'play';
            // Broadcast the state, including the isAdStall flag
            broadcastState(action, currentTime, currentVideoId, isAdStall);
        }
    }
}

function onPlayerStateChange(event) {
    const playPauseBtn = document.getElementById('play-pause-btn');
    const playIcon = '<i class="fa-solid fa-play"></i>';
    const pauseIcon = '<i class="fa-solid fa-pause"></i>';
    
    if (event.data === YT.PlayerState.PLAYING) {
        playPauseBtn.innerHTML = pauseIcon;
        isManualAction = false; 
        
        // Broadcast PLAY immediately if a manual action happened recently
        const timeSinceLastAction = Date.now() - lastLocalActionTime;
        if (timeSinceLastAction < 500 && lastBroadcaster === fixedDBName) {
            broadcastState('play', player.getCurrentTime(), currentVideoId, false);
        }
        
    } else {
        playPauseBtn.innerHTML = playIcon;

        if (event.data === YT.PlayerState.PAUSED || event.data === YT.PlayerState.BUFFERING) {
            
            const timeSinceLastAction = Date.now() - lastLocalActionTime;

            // Broadcast general pause if it was manual (timeSinceLastAction < 500)
            if (timeSinceLastAction < 500 && lastBroadcaster === fixedDBName) {
                 broadcastState('pause', player.getCurrentTime(), currentVideoId, false);
            }
            // Note: The AdStall check is now handled by broadcastTimeIfPlaying (Time Stagnation Detection)
        } 
        
        if (event.data === YT.PlayerState.ENDED) {
            if (!isPartnerPlaying) {
                 broadcastState('pause', player.getCurrentTime(), currentVideoId, false); 
            }
            playNextSong();
        }
    }
    
    isPartnerPlaying = false; 
    updateSyncStatus();
}

function togglePlayPause() {
    if (!player || !player.getPlayerState) return;

    lastLocalActionTime = Date.now(); 
    isManualAction = true;
    lastBroadcaster = fixedDBName; 
    
    const state = player.getPlayerState();
    
    if (state === YT.PlayerState.PLAYING || state === YT.PlayerState.BUFFERING) {
        player.pauseVideo();
        document.getElementById('syncOverlay').classList.remove('active'); 
        
        // Broadcast PAUSE immediately (isAdStall: false since it's manual)
        broadcastState('pause', player.getCurrentTime(), currentVideoId, false); 
        
    } else {
        if (!currentVideoId && currentQueue.length > 0) {
            loadAndPlayVideo(currentQueue[0].videoId, currentQueue[0].title);
        } else if (currentVideoId) {
            player.playVideo();
            document.getElementById('syncOverlay').classList.remove('active');
            
            // Broadcast PLAY immediately
            broadcastState('play', player.getCurrentTime(), currentVideoId, false);
        }
    }
}

function loadAndPlayVideo(videoId, title) {
    if (player && videoId) {
        lastBroadcaster = fixedDBName; 
        lastLocalActionTime = Date.now(); 
        
        player.loadVideoById(videoId);
        currentVideoId = videoId;
        document.getElementById('current-song-title').textContent = title;
        
        setTimeout(() => {
            // If the song loads and starts playing, broadcast play
            if(player.getPlayerState() === YT.PlayerState.PLAYING || player.getPlayerState() === YT.PlayerState.BUFFERING) {
                 broadcastState('play', player.getCurrentTime(), videoId, false); 
            }
        }, 500); 
        
        renderQueue(currentQueue, currentVideoId);
    }
}


// ------------------------------------------------------------------------------------------------------
// --- QUEUE MANAGEMENT ---
// ------------------------------------------------------------------------------------------------------
function playNextSong() {
    const currentIndex = currentQueue.findIndex(song => song.videoId === currentVideoId);
    let nextIndex = (currentIndex + 1) % currentQueue.length; 
    
    if (currentQueue.length > 0) {
        if (currentIndex === -1) nextIndex = 0; 

        const nextSong = currentQueue[nextIndex];
        loadAndPlayVideo(nextSong.videoId, nextSong.title);
    } else {
        currentVideoId = null;
        if (player && player.stopVideo) player.stopVideo();
        document.getElementById('current-song-title').textContent = "Queue Ended";
    }
}

function playPreviousSong() {
    const currentIndex = currentQueue.findIndex(song => song.videoId === currentVideoId);
    let prevIndex = currentIndex - 1;
    if (prevIndex < 0) { prevIndex = currentQueue.length - 1; } 
    
    if (currentQueue.length > 0) {
        if (currentIndex === -1) prevIndex = currentQueue.length - 1;

        const prevSong = currentQueue[prevIndex];
        loadAndPlayVideo(prevSong.videoId, prevSong.title);
    }
}

function addToQueue(videoId, title, uploader, thumbnail, event) {
    if (event) event.stopPropagation();
    
    const newSong = { 
        videoId, 
        title, 
        uploader, 
        thumbnail, 
        // Use a high order number to ensure it appears at the end
        order: Date.now() + Math.random() 
    };
    const newKey = queueRef.push().key; 
    
    queueRef.child(newKey).set(newSong)
        .then(() => { 
            switchTab('queue'); 
            
            if (!currentVideoId && currentQueue.length === 0) {
                setTimeout(() => {
                    loadAndPlayVideo(videoId, title);
                }, 300);
            }
        })
        .catch(error => { console.error("Error adding song to queue:", error); });
}

function addBatchToQueue(songs) {
    if (!songs || songs.length === 0) return;
    const updates = {};
    const startTime = Date.now();

    songs.forEach((song, index) => {
        const newKey = queueRef.push().key;
        updates[newKey] = { 
            videoId: song.videoId, 
            title: song.title, 
            uploader: song.uploader, 
            thumbnail: song.thumbnail, 
            order: startTime + index 
        }; 
    });
    
    queueRef.update(updates)
        .then(() => {
            switchTab('queue');
            if (!currentVideoId && currentQueue.length === 0 && songs.length > 0) {
                setTimeout(() => {
                    const firstSong = currentQueue[0];
                    if (firstSong) { loadAndPlayVideo(firstSong.videoId, firstSong.title); }
                }, 500);
            }
        })
        .catch(error => { console.error("Error adding batch to queue:", error); });
}

function removeFromQueue(key, event) {
    if (event) event.stopPropagation();
    
    const songToRemove = currentQueue.find(song => song.key === key);
    
    if (songToRemove) {
        queueRef.child(key).remove()
            .then(() => {
                if (songToRemove.videoId === currentVideoId) { 
                    playNextSong(); 
                }
            })
            .catch(error => { console.error("Error removing song:", error); });
    }
}

function updateQueueOrder(newOrder) {
    const updates = {};
    newOrder.forEach((song, index) => {
        // Use the index as the new 'order' value
        updates[`${song.key}/order`] = index;
    });

    queueRef.update(updates)
        .catch(error => console.error("Error updating queue order:", error));
}


// ------------------------------------------------------------------------------------------------------
// --- RENDERING VIEWS ---
// ------------------------------------------------------------------------------------------------------
function switchTab(tabName) {
    document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
    document.querySelectorAll('.list-view').forEach(list => list.classList.remove('active'));
    document.getElementById(`tab-${tabName}`).classList.add('active');
    
    const targetList = document.getElementById(`${tabName}-list`);
    targetList.classList.add('active');

    if (tabName === 'chat') {
         const chatMessages = document.getElementById('chat-messages');
         setTimeout(() => {
             chatMessages.scrollTop = chatMessages.scrollHeight;
         }, 0);
    }
}

function renderQueue(queueArray, currentVideoId) {
    const queueList = document.getElementById('queue-list');
    
    queueList.innerHTML = '';
    
    // Always sort by order field from Firebase
    queueArray.sort((a, b) => (a.order || 0) - (b.order || 0));
    currentQueue = queueArray; 

    if (queueArray.length === 0) {
        queueList.innerHTML = '<p class="empty-state">Queue is empty. Find a song to get the party started!</p>';
        document.getElementById('queue-count').textContent = 0;
        return;
    }
    
    queueArray.forEach((song, index) => {
        const item = document.createElement('div');
        const itemClasses = 'song-item' + (song.videoId === currentVideoId ? ' playing' : '');
        item.className = itemClasses;
        // CRITICAL for drag-drop
        item.setAttribute('draggable', 'true'); 
        item.setAttribute('data-key', song.key); 
        item.setAttribute('data-video-id', song.videoId); 
        
        item.innerHTML = `
            <i class="fa-solid fa-grip-vertical drag-handle"></i>
            <img src="${song.thumbnail}" class="thumb" alt="Thumbnail">
            <div class="meta">
                <h4>${index + 1}. ${song.title}</h4>
                <p>Uploader: ${song.uploader}</p>
            </div>
            <div class="item-controls">
                <button class="del-btn" title="Remove from Queue" onclick="removeFromQueue('${song.key}', event)">
                    <i class="fa-solid fa-trash-can"></i>
                </button>
            </div>
        `;
        queueList.appendChild(item);
    });
    
    document.getElementById('queue-count').textContent = queueArray.length;
    
    // CRITICAL FIX: Attach drag/drop listeners after rendering
    addDragDropListeners(queueList, queueArray); 

    const playingItem = queueList.querySelector('.song-item.playing');
    if (playingItem) {
        playingItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

function renderSearchResults(resultsArray) {
    const resultsList = document.getElementById('results-list');
    resultsList.querySelector('.empty-state.search-status')?.remove(); 
    
    const searchContainer = resultsList.querySelector('.search-container');
    let resultContainer = resultsList.querySelector('.result-container');
    
    if (!resultContainer) {
         resultContainer = document.createElement('div');
         resultContainer.className = 'result-container';
         resultsList.insertBefore(resultContainer, searchContainer ? searchContainer.nextSibling : null); 
    }
    resultContainer.innerHTML = '';
    currentSearchResults = resultsArray;

    if (resultsArray.length === 0) {
         resultContainer.innerHTML = '<p class="empty-state">No search results found. Try a different query!</p>';
         return;
    }
    
    resultsArray.forEach(song => {
        const item = document.createElement('div');
        item.className = 'song-item';
        const safeThumbnail = encodeURIComponent(song.thumbnail);
        
        item.innerHTML = `
            <img src="${song.thumbnail}" class="thumb" alt="Thumbnail">
            <div class="meta">
                <h4>${song.title}</h4>
                <p>Uploader: ${song.uploader}</p>
            </div>
            <button class="add-btn" title="Add to Queue" onclick="addToQueue('${song.videoId}', '${song.title.replace(/'/g, "\\'")}', '${song.uploader.replace(/'/g, "\\'")}', decodeURIComponent('${safeThumbnail}'), event)">
                <i class="fa-solid fa-plus"></i>
            </button>
        `;
        resultContainer.appendChild(item);
    });
}

// NEW: Full implementation of Drag and Drop for queue reordering
function addDragDropListeners(listElement, originalQueue) {
    let draggingItem = null;

    listElement.querySelectorAll('.song-item').forEach(item => {
        
        item.addEventListener('dragstart', (e) => {
            if (e.target.closest('.del-btn')) {
                e.preventDefault();
                return;
            }
            draggingItem = item;
            item.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', item.getAttribute('data-key'));
        });

        item.addEventListener('dragover', (e) => {
            e.preventDefault(); 
            e.dataTransfer.dropEffect = 'move';
            if (item !== draggingItem && draggingItem) {
                const rect = item.getBoundingClientRect();
                const offsetY = e.clientY - rect.top;
                if (offsetY < rect.height / 2) {
                    // Insert before the item (hovering top half)
                    listElement.insertBefore(draggingItem, item);
                } else {
                    // Insert after the item (hovering bottom half)
                    listElement.insertBefore(draggingItem, item.nextSibling);
                }
            }
        });

        item.addEventListener('dragend', () => {
            if (draggingItem) {
                draggingItem.classList.remove('dragging');
            }
            draggingItem = null;
            
            // Get the new order of keys based on the DOM structure
            const newOrderKeys = Array.from(listElement.querySelectorAll('.song-item'))
                                         .map(el => el.getAttribute('data-key'));
            
            // Map the keys back to the song objects and create the new order array
            const newOrder = newOrderKeys.map(key => currentQueue.find(song => song.key === key)).filter(Boolean);
            
            // Update Firebase
            updateQueueOrder(newOrder); 
        });
        
        // Stop propagation for delete/drag handle clicks
        item.querySelector('.item-controls')?.addEventListener('click', (e) => {
            e.stopPropagation();
        });
        
        item.querySelector('.drag-handle')?.addEventListener('click', (e) => {
            e.stopPropagation();
        });
        
        // Click listener for playing the song
        item.addEventListener('click', (e) => {
            // Check if the click originated from a control element inside the item
            if (e.defaultPrevented || e.target.closest('.drag-handle') || e.target.closest('.item-controls')) return; 
            
            const videoId = item.getAttribute('data-video-id');
            const song = originalQueue.find(s => s.videoId === videoId);
            if (song) {
                loadAndPlayVideo(song.videoId, song.title);
            }
        });
    });
}


// ------------------------------------------------------------------------------------------------------
// --- SEARCH & LINK HANDLERS ---
// ------------------------------------------------------------------------------------------------------
async function searchYouTube(query, maxResults = 10, type = 'video') {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=${type}&maxResults=${maxResults}&key=${YOUTUBE_API_KEY}`;
    
    try {
        const response = await fetch(url);
        const data = await response.json();

        if (data.error) {
            console.error("YouTube API Error:", data.error.message);
            return [];
        }

        const results = data.items
            .filter(item => item.id.kind === 'youtube#video')
            .map(item => ({
                videoId: item.id.videoId,
                title: item.snippet.title,
                uploader: item.snippet.channelTitle,
                thumbnail: item.snippet.thumbnails.default.url 
            }));
        
        return results;

    } catch (error) {
        console.error("YouTube Search Fetch Error:", error);
        return [];
    }
}

function extractPlaylistId(url) {
    const regex = /(?:list=)([a-zA-Z0-9_-]+)/;
    const match = url.match(regex);
    if (match) {
        return match[1];
    }
    return null;
}

async function fetchPlaylist(playlistId, pageToken = null, allSongs = []) {
    switchTab('results');
    const resultsList = document.getElementById('results-list');
    
    resultsList.querySelector('.result-container')?.remove(); 
    
    let statusEl = resultsList.querySelector('.playlist-status');
    if (!statusEl) {
        statusEl = document.createElement('p');
        statusEl.className = 'empty-state playlist-status';
        resultsList.insertBefore(statusEl, resultsList.querySelector('.search-container') ? resultsList.querySelector('.search-container').nextSibling : null);
    }
    statusEl.innerHTML = `Fetching playlist (Total songs: ${allSongs.length})... Please wait.`;
    statusEl.style.color = 'var(--text-dim)';


    const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=50&playlistId=${playlistId}&key=${YOUTUBE_API_KEY}${pageToken ? `&pageToken=${pageToken}` : ''}`;
    
    try {
        const response = await fetch(url);
        const data = await response.json();

        if (data.error) {
            statusEl.innerHTML = `Error fetching playlist: ${data.error.message}. Check the link or your API key.`;
            statusEl.style.color = 'var(--text-error)';
            return;
        }

        const newSongs = data.items
            .filter(item => item.snippet && item.snippet.resourceId && item.snippet.resourceId.kind === 'youtube#video')
            .map(item => ({
                videoId: item.snippet.resourceId.videoId,
                title: item.snippet.title,
                uploader: item.snippet.channelTitle,
                thumbnail: item.snippet.thumbnails.default.url
            }));
        
        allSongs = allSongs.concat(newSongs);

        if (data.nextPageToken) {
            return await fetchPlaylist(playlistId, data.nextPageToken, allSongs);
        } else {
            statusEl.innerHTML = `✅ Found ${allSongs.length} songs from the playlist. Adding to queue...`;
            statusEl.style.color = 'var(--primary)';
            addBatchToQueue(allSongs);
            setTimeout(() => {
                switchTab('queue');
                statusEl.remove();
            }, 3000); 
        }

    } catch (error) {
        console.error("Playlist Fetch Error:", error);
        statusEl.innerHTML = 'Failed to fetch playlist items. Network error or invalid ID.';
        statusEl.style.color = 'var(--text-error)';
    }
}

function extractSpotifyId(url) {
    const match = url.match(/(?:playlist|album|track)\/([a-zA-Z0-9]+)/);
    if (match) {
        return url; 
    }
    return null;
}

async function fetchSpotifyData(link) {
    switchTab('results');
    const resultsList = document.getElementById('results-list');
     let statusEl = resultsList.querySelector('.spotify-status');
     if (!statusEl) {
        statusEl = document.createElement('p');
        statusEl.className = 'empty-state spotify-status';
        resultsList.insertBefore(statusEl, resultsList.querySelector('.search-container') ? resultsList.querySelector('.search-container').nextSibling : null);
    }
    statusEl.innerHTML = 'Attempting to fetch Spotify data and find YouTube matches (This may take a moment)...';
    statusEl.style.color = 'var(--text-dim)';
    resultsList.querySelector('.result-container')?.remove();

    const proxyUrl = `https://spotify-proxy.vercel.app/api/data?url=${encodeURIComponent(link)}`;

    try {
        const response = await fetch(proxyUrl);
        const data = await response.json();

        if (!data || data.error || !data.tracks || data.tracks.length === 0) {
            statusEl.innerHTML = `Failed to fetch Spotify data or playlist is empty. (Error: ${data.error || 'Unknown'})`;
            statusEl.style.color = 'var(--text-error)';
            return;
        }
        
        const tracksToSearch = data.tracks.slice(0, 30); 
        const foundSongs = [];
        
        statusEl.innerHTML = `Found ${tracksToSearch.length} tracks. Searching YouTube for matches...`;

        for (const track of tracksToSearch) {
            const query = `${track.artist} - ${track.title}`;
            const results = await searchYouTube(query, 1); 
            
            if (results.length > 0) {
                foundSongs.push(results[0]);
            }
            statusEl.innerHTML = `Searching YouTube... Found ${foundSongs.length} matches out of ${tracksToSearch.length} tracks.`;
        }
        
        if (foundSongs.length > 0) {
            statusEl.innerHTML = `✅ Added ${foundSongs.length} songs from Spotify link to the queue!`;
            statusEl.style.color = 'var(--primary)';
            addBatchToQueue(foundSongs);
        } else {
            statusEl.innerHTML = `Could not find matching YouTube videos for the Spotify tracks.`;
            statusEl.style.color = 'var(--text-error)';
        }
        setTimeout(() => {
            switchTab('queue');
            statusEl.remove();
        }, 3000); 
        
    } catch (error) {
        console.error("Spotify Proxy Error:", error);
        statusEl.innerHTML = 'Connection error while fetching Spotify data. The proxy may be down.';
        statusEl.style.color = 'var(--text-error)';
    }
}

async function handleSearchAndLinks() {
    const inputElement = document.getElementById('searchInput');
    const query = inputElement.value.trim();
    if (!query) return;

    const resultsList = document.getElementById('results-list');
    resultsList.querySelector('.empty-state.search-status')?.remove();
    resultsList.querySelector('.playlist-status')?.remove();
    resultsList.querySelector('.spotify-status')?.remove();
    resultsList.querySelector('.result-container')?.remove();
    
    const playlistId = extractPlaylistId(query);
    if (playlistId) {
        await fetchPlaylist(playlistId);
        inputElement.value = ''; 
        return;
    }
    
    const spotifyLink = extractSpotifyId(query);
    if (spotifyLink) {
        await fetchSpotifyData(spotifyLink); 
        inputElement.value = '';
        return;
    }

    switchTab('results');
    
    let searchStatusEl = resultsList.querySelector('.search-status');
    if (!searchStatusEl) {
        searchStatusEl = document.createElement('p');
        searchStatusEl.className = 'empty-state search-status';
        resultsList.insertBefore(searchStatusEl, resultsList.querySelector('.search-container') ? resultsList.querySelector('.search-container').nextSibling : null);
    }
    searchStatusEl.innerHTML = 'Searching...';

    currentSearchResults = await searchYouTube(query, 10);
    
    if (currentSearchResults.length === 0) {
        searchStatusEl.innerHTML = 'Search failed! Check your API key, network, or try a simpler query.';
        searchStatusEl.style.color = 'var(--text-error)';
    } else {
        searchStatusEl.remove(); 
        renderSearchResults(currentSearchResults);
    }
    
    inputElement.value = '';
}


// ------------------------------------------------------------------------------------------------------
// --- FIREBASE SYNC ---
// ------------------------------------------------------------------------------------------------------

function loadInitialData() {
    // 1. Queue Listener 
    queueRef.orderByChild('order').on('value', (snapshot) => {
        const queueData = snapshot.val();
        let fetchedQueue = [];
        if (queueData) {
            Object.keys(queueData).forEach(key => {
                fetchedQueue.push({ ...queueData[key], key: key });
            });
        }
        
        fetchedQueue.sort((a, b) => (a.order || 0) - (b.order || 0));
        currentQueue = fetchedQueue;
        renderQueue(currentQueue, currentVideoId);
    });

    // 2. Sync Command Listener (Listens to the PARTNER's sync node)
    partnerSyncRef.on('value', (snapshot) => {
        const syncState = snapshot.val();
        lastSyncState = syncState; 

        if (syncState) {
            lastBroadcaster = syncState.lastUpdater; 

            // Only apply command if the partner is the broadcaster
            if (syncState.lastUpdater !== fixedDBName) {
                applyRemoteCommand(syncState);
            }
        } else {
             document.getElementById('syncOverlay').classList.remove('active');
        }
        
        updateSyncStatus();
    });

    // 3. Chat Listener (Listens to MY chatRef for local messages)
    myChatRef.limitToLast(50).on('child_added', (snapshot) => {
        const message = snapshot.val();
        // Prevent double display
        if (message.user === myName) { 
             displayChatMessage(message.user, message.text, message.timestamp);
        }
    });
    
    // 4. Chat Listener (Listens to PARTNER's chat path for their messages)
    partnerChatRef.limitToLast(50).on('child_added', (snapshot) => {
        const message = snapshot.val();
        // Only display partner messages
        if (message.user !== myName) { 
             displayChatMessage(message.user, message.text, message.timestamp);
        }
    });
}

function broadcastState(action, time, videoId = currentVideoId, isAdStall = false) {
    if (!videoId) return;

    mySyncRef.set({
        action: action, 
        time: time,
        videoId: videoId,
        lastUpdater: fixedDBName, // Use fixedDBName as the consistent identifier
        isAdStall: isAdStall, // NEW: Flag for ad/buffer stall
        timestamp: Date.now()
    });
}

// FIX: Strictly follows remote command and handles new AdStall flag
function applyRemoteCommand(state) {
    if (!player || !state || state.videoId === undefined) return;
    
    const partnerIsPlaying = state.action === 'play';
    isPartnerPlaying = true; 
    const localTime = player.getCurrentTime ? player.getCurrentTime() : 0; 
    
    // CRITICAL FIX: Ignore remote signal if we just performed a manual action (within 500ms)
    const timeSinceLastLocalAction = Date.now() - lastLocalActionTime;
    if (timeSinceLastLocalAction < 500) {
        return; 
    }
    
    // SCENARIO 1: PARTNER IS STALLED (Ad/Buffer - New logic)
    if (state.isAdStall) {
           document.getElementById('syncOverlay').classList.add('active');
           if (player.getPlayerState() !== YT.PlayerState.PAUSED) {
             player.pauseVideo();
           }
           updateSyncStatus();
           return; 
    }
    
    document.getElementById('syncOverlay').classList.remove('active');
    
    // SCENARIO 2: PARTNER CHANGED SONG
    if (state.videoId !== currentVideoId) {
        const song = currentQueue.find(s => s.videoId === state.videoId);
        const title = song ? song.title : 'External Sync';

        // Load and seek to partner's time
        player.loadVideoById(state.videoId, state.time);
        currentVideoId = state.videoId;
        document.getElementById('current-song-title').textContent = title;
        renderQueue(currentQueue, currentVideoId);
        
        // Ensure play state is set correctly after loading
        if (partnerIsPlaying) {
            player.playVideo();
        } else {
            player.pauseVideo();
        }
        
    } else {
        // SCENARIO 3: SAME SONG, HANDLE PLAY/PAUSE AND SEEK
        
        // Handle Play/Pause Command
        if (partnerIsPlaying) {
            if (player.getPlayerState() !== YT.PlayerState.PLAYING) {
                player.playVideo();
            }
        } else {
            if (player.getPlayerState() !== YT.PlayerState.PAUSED) {
                player.pauseVideo();
            }
        }
        
        // Handle Time Sync (Automatic Resync)
        const localPlayerState = player.getPlayerState();
        const timeDiff = Math.abs(localTime - state.time);
        
        // Only seek if the difference is significant (> 1.5 seconds) AND the partner is playing
        if (partnerIsPlaying && localPlayerState === YT.PlayerState.PLAYING && timeDiff > 1.5) { 
            player.seekTo(state.time, true);
        }
    }
    updateSyncStatus();
}

function forcePlay() {
    document.getElementById('syncOverlay').classList.remove('active');
    lastBroadcaster = fixedDBName; 
    lastLocalActionTime = Date.now();
    if (currentVideoId) {
        player.playVideo();
        broadcastState('play', player.getCurrentTime(), currentVideoId, false);
    }
}

// REMOVED ** MARKDOWN
function updateSyncStatus() {
    const msgEl = document.getElementById('sync-status-msg');
    
    if (!lastSyncState) {
        msgEl.innerHTML = `<i class="fa-solid fa-pause"></i> PAUSED`;
        msgEl.style.color = 'var(--text-dim)';
        return;
    }

    const broadcasterName = (lastBroadcaster === fixedDBName) ? myName : partnerDisplayLabel; 

    // Check if the current song is still the synced video
    if (lastSyncState.videoId !== currentVideoId && lastSyncState.action === 'play') {
        const title = currentQueue.find(song => song.videoId === lastSyncState.videoId)?.title || 'A New Track';
        msgEl.innerHTML = `<i class="fa-solid fa-shuffle"></i> SWITCHING TO: ${broadcasterName}'s Track (${title})`;
        msgEl.style.color = 'var(--accent)';
    } else if (lastSyncState.videoId === currentVideoId && lastSyncState.action === 'play' && Math.abs(player.getCurrentTime() - lastSyncState.time) > 2) {
        msgEl.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> OUT OF SYNC`;
        msgEl.style.color = 'var(--text-error)';
    } else if (player && (player.getPlayerState() === YT.PlayerState.PAUSED || player.getPlayerState() === YT.PlayerState.BUFFERING)) {
        
        if (!isPartnerPlaying && lastSyncState.isAdStall) {
            // Partner is reporting an ad stall
            msgEl.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> AD STALL (Waiting for ${broadcasterName})`;
            msgEl.style.color = 'var(--text-error)';
        } else {
             // Standard paused state
            msgEl.innerHTML = `<i class="fa-solid fa-pause"></i> PAUSED`;
            msgEl.style.color = 'var(--text-dim)';
        }
        
    } else if (player && player.getPlayerState() === YT.PlayerState.PLAYING) {
        msgEl.innerHTML = `<i class="fa-solid fa-satellite-dish"></i> DEEP SYNC ACTIVE`;
        msgEl.style.color = 'var(--primary)';
    } else {
        // Fallback for non-playing/unknown state (e.g. ended)
        msgEl.innerHTML = `<i class="fa-solid fa-pause"></i> PAUSED`;
        msgEl.style.color = 'var(--text-dim)';
    }
}

// ------------------------------------------------------------------------------------------------------
// --- CHAT FUNCTIONS ---
// ------------------------------------------------------------------------------------------------------

function sendChatMessage() {
    const input = document.getElementById('chatInput');
    const text = input.value.trim();
    if (!text) return;

    const messagePayload = {
        user: myName,
        text: text,
        timestamp: Date.now()
    };

    // Write to the PARTNER's chat path so they receive it.
    partnerChatRef.push(messagePayload).then(() => {
        // Also write to my own chat path for the local client to display it immediately.
        myChatRef.push(messagePayload);
        input.value = ''; 
    }).catch(error => {
        console.error("Error sending message:", error);
    });
}

function displayChatMessage(user, text, timestamp) {
    const chatMessages = document.getElementById('chat-messages');
    const isMe = user === myName;
    
    const time = new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    
    const msgDiv = document.createElement('div');
    msgDiv.className = `chat-message ${isMe ? 'me' : 'partner'}`;
    
    const safeText = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    if (chatMessages.querySelector('.empty-state')) {
        chatMessages.innerHTML = '';
    }

    msgDiv.innerHTML = `
        <strong>${user}:</strong> ${safeText}
        <small>${time}</small>
    `;
    
    chatMessages.appendChild(msgDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight; 
}


// ------------------------------------------------------------------------------------------------------
// --- INITIALIZATION: EVENT LISTENERS ---
// ------------------------------------------------------------------------------------------------------

function initializeAppListeners() {
    console.log("Setting up application event listeners...");
    
    document.getElementById('play-pause-btn').addEventListener('click', togglePlayPause);
    document.getElementById('prev-btn').addEventListener('click', playPreviousSong);
    document.getElementById('next-btn').addEventListener('click', playNextSong);

    document.getElementById('search-btn').addEventListener('click', handleSearchAndLinks);
    document.getElementById('searchInput').addEventListener('keypress', function (e) {
        if (e.key === 'Enter') {
            handleSearchAndLinks();
        }
    });
    
    document.getElementById('tab-results').addEventListener('click', () => switchTab('results'));
    document.getElementById('tab-queue').addEventListener('click', () => switchTab('queue'));
    document.getElementById('tab-chat').addEventListener('click', () => switchTab('chat'));

    document.getElementById('sendChatBtn').addEventListener('click', sendChatMessage);
    document.getElementById('chatInput').addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
            sendChatMessage();
        }
    });
    
    document.getElementById('forceSyncBtn').addEventListener('click', forcePlay);
}

document.addEventListener('DOMContentLoaded', initializeAppListeners);
