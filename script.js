/**
 * ===========================================================
 * P2P FILE SHARING APPLICATION
 * ===========================================================
 * A production-grade, serverless peer-to-peer file sharing
 * application using WebRTC Data Channels.
 * 
 * Features:
 * - Manual signaling (no server required)
 * - File chunking for large file support (1GB+)
 * - Backpressure management for optimal transfer
 * - Real-time progress tracking
 * - End-to-end encryption (WebRTC default DTLS)
 * 
 * @author Senior Software Architect
 * @version 1.0.0
 * ===========================================================
 */

// ===========================================
// IIFE TO AVOID GLOBAL NAMESPACE POLLUTION
// ===========================================
const P2PApp = (function() {
    'use strict';

    // ===========================================
    // CONFIGURATION CONSTANTS
    // ===========================================
    
    /** Size of each file chunk in bytes (16KB for optimal performance) */
    const CHUNK_SIZE = 16 * 1024; // 16KB
    
    /** Maximum buffer threshold before pausing transmission (backpressure) */
    const BUFFER_THRESHOLD = 256 * 1024; // 256KB
    
    /** Low buffer threshold to resume transmission */
    const BUFFER_LOW_THRESHOLD = 64 * 1024; // 64KB
    
    /** ICE server configuration using public STUN servers */
    const ICE_SERVERS = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' },
            { urls: 'stun:stun3.l.google.com:19302' },
            { urls: 'stun:stun4.l.google.com:19302' }
        ]
    };

    // ===========================================
    // APPLICATION STATE
    // ===========================================
    
    /** Current role: 'sender' | 'receiver' | null */
    let currentRole = null;
    
    /** RTCPeerConnection instance */
    let peerConnection = null;
    
    /** RTCDataChannel instance */
    let dataChannel = null;
    
    /** Selected file to send (sender only) */
    let selectedFile = null;
    
    /** Indicates if connection is established */
    let isConnected = false;
    
    /** ICE gathering complete flag */
    let iceGatheringComplete = false;

    // --- File Transfer State (Sender) ---
    
    /** Flag indicating if a transfer is in progress */
    let sendingInProgress = false;
    
    /** Flag indicating if sending is paused due to backpressure */
    let sendPaused = false;
    
    /** Current chunk index being sent */
    let currentChunkIndex = 0;
    
    /** Total number of chunks */
    let totalChunks = 0;

    // --- File Transfer State (Receiver) ---
    
    /** Received file chunks */
    let receivedChunks = [];
    
    /** Metadata of file being received */
    let receivedFileInfo = null;
    
    /** Total bytes received */
    let receivedBytes = 0;

    // --- Progress Tracking ---
    
    /** Transfer start timestamp for speed calculation */
    let transferStartTime = 0;
    
    /** Last progress update timestamp */
    let lastProgressUpdate = 0;
    
    /** Bytes transferred at last progress update */
    let lastTransferredBytes = 0;

    // ===========================================
    // DOM ELEMENT REFERENCES
    // ===========================================
    
    const elements = {
        // Status
        statusBanner: document.getElementById('statusBanner'),
        statusIndicator: document.getElementById('statusIndicator'),
        statusText: document.getElementById('statusText'),
        roleBadge: document.getElementById('roleBadge'),
        transferBadge: document.getElementById('transferBadge'),
        
        // Role selection
        roleSelection: document.getElementById('roleSelection'),
        btnSender: document.getElementById('btnSender'),
        btnReceiver: document.getElementById('btnReceiver'),
        
        // Panels
        senderPanel: document.getElementById('senderPanel'),
        receiverPanel: document.getElementById('receiverPanel'),
        
        // Textareas
        localOffer: document.getElementById('localOffer'),
        remoteAnswer: document.getElementById('remoteAnswer'),
        remoteOffer: document.getElementById('remoteOffer'),
        localAnswer: document.getElementById('localAnswer'),
        
        // File handling
        fileDropZone: document.getElementById('fileDropZone'),
        fileInput: document.getElementById('fileInput'),
        fileInfo: document.getElementById('fileInfo'),
        fileTypeIcon: document.getElementById('fileTypeIcon'),
        fileName: document.getElementById('fileName'),
        fileMeta: document.getElementById('fileMeta'),
        sendButtonContainer: document.getElementById('sendButtonContainer'),
        btnSendFile: document.getElementById('btnSendFile'),
        
        // Progress
        progressSection: document.getElementById('progressSection'),
        progressTitle: document.getElementById('progressTitle'),
        progressStats: document.getElementById('progressStats'),
        progressBar: document.getElementById('progressBar'),
        progressTransferred: document.getElementById('progressTransferred'),
        progressTotal: document.getElementById('progressTotal'),
        progressSpeed: document.getElementById('progressSpeed'),
        progressETA: document.getElementById('progressETA'),
        
        // Download
        downloadSection: document.getElementById('downloadSection'),
        downloadInfo: document.getElementById('downloadInfo'),
        downloadLink: document.getElementById('downloadLink'),
        
        // Waiting
        waitingForFile: document.getElementById('waitingForFile'),
        
        // Instructions
        instructions: document.getElementById('instructions'),
        instructionsList: document.getElementById('instructionsList'),
        
        // Log
        logContent: document.getElementById('logContent'),
        logToggle: document.getElementById('logToggle'),
        
        // Toast
        toastContainer: document.getElementById('toastContainer')
    };

    // ===========================================
    // UTILITY FUNCTIONS
    // ===========================================

    /**
     * Formats bytes into human-readable string
     * @param {number} bytes - Number of bytes
     * @param {number} decimals - Decimal places (default: 2)
     * @returns {string} Formatted string (e.g., "1.5 MB")
     */
    function formatBytes(bytes, decimals = 2) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(decimals)) + ' ' + sizes[i];
    }

    /**
     * Formats seconds into MM:SS or HH:MM:SS string
     * @param {number} seconds - Number of seconds
     * @returns {string} Formatted time string
     */
    function formatTime(seconds) {
        if (!isFinite(seconds) || seconds < 0) return '--:--';
        const hrs = Math.floor(seconds / 3600);
        const mins = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);
        if (hrs > 0) {
            return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
        }
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }

    /**
     * Gets current timestamp string for logging
     * @returns {string} Timestamp in HH:MM:SS format
     */
    function getTimestamp() {
        return new Date().toLocaleTimeString('en-US', { hour12: false });
    }

    /**
     * Adds an entry to the connection log
     * @param {string} message - Log message
     * @param {string} type - Message type: 'info' | 'success' | 'warning' | 'error'
     */
    function log(message, type = 'info') {
        const entry = document.createElement('div');
        entry.className = 'log-entry';
        entry.innerHTML = `
            <span class="log-time">[${getTimestamp()}]</span>
            <span class="log-message ${type}">${message}</span>
        `;
        elements.logContent.appendChild(entry);
        elements.logContent.scrollTop = elements.logContent.scrollHeight;
        console.log(`[${type.toUpperCase()}] ${message}`);
    }

    /**
     * Shows a toast notification
     * @param {string} message - Toast message
     * @param {string} type - Toast type: 'info' | 'success' | 'error'
     */
    function showToast(message, type = 'info') {
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.innerHTML = `<span>${message}</span>`;
        elements.toastContainer.appendChild(toast);
        
        setTimeout(() => {
            toast.style.animation = 'slideIn 0.3s ease reverse';
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    /**
     * Copies text from a textarea to clipboard
     * @param {string} elementId - ID of the textarea element
     */
    async function copyToClipboard(elementId) {
        const textarea = document.getElementById(elementId);
        const text = textarea.value;
        
        if (!text) {
            showToast('Nothing to copy!', 'error');
            return;
        }
        
        try {
            await navigator.clipboard.writeText(text);
            showToast('Copied to clipboard!', 'success');
            log('Connection data copied to clipboard', 'success');
        } catch (err) {
            // Fallback for older browsers
            textarea.select();
            document.execCommand('copy');
            showToast('Copied to clipboard!', 'success');
            log('Connection data copied to clipboard (fallback)', 'success');
        }
    }

    /**
     * Updates the application status display
     * @param {string} status - Status: 'idle' | 'waiting' | 'connected' | 'transferring' | 'completed' | 'error'
     * @param {string} text - Status text to display
     */
    function updateStatus(status, text) {
        elements.statusIndicator.className = `status-indicator ${status}`;
        elements.statusText.textContent = text;
    }

    /**
     * Gets file type icon based on MIME type
     * @param {string} type - MIME type
     * @returns {string} Emoji icon
     */
    function getFileIcon(type) {
        if (!type) return '📄';
        if (type.startsWith('image/')) return '🖼️';
        if (type.startsWith('video/')) return '🎬';
        if (type.startsWith('audio/')) return '🎵';
        if (type.startsWith('text/')) return '📝';
        if (type.includes('pdf')) return '📕';
        if (type.includes('zip') || type.includes('rar') || type.includes('7z')) return '📦';
        if (type.includes('word') || type.includes('document')) return '📘';
        if (type.includes('excel') || type.includes('spreadsheet')) return '📗';
        if (type.includes('powerpoint') || type.includes('presentation')) return '📙';
        return '📄';
    }

    /**
     * Toggles the log panel visibility
     */
    function toggleLog() {
        const isCollapsed = elements.logContent.classList.toggle('collapsed');
        elements.logToggle.textContent = isCollapsed ? 'Show' : 'Hide';
    }

    // ===========================================
    // ROLE SELECTION
    // ===========================================

    /**
     * Handles role selection (sender or receiver)
     * @param {string} role - Selected role: 'sender' | 'receiver'
     */
    function selectRole(role) {
        currentRole = role;
        
        // Update button states
        elements.btnSender.classList.remove('active', 'sender');
        elements.btnReceiver.classList.remove('active', 'receiver');
        
        if (role === 'sender') {
            elements.btnSender.classList.add('active', 'sender');
            elements.senderPanel.classList.remove('hidden');
            elements.receiverPanel.classList.add('hidden');
            elements.fileDropZone.classList.remove('hidden');
            elements.waitingForFile.classList.add('hidden');
            elements.roleBadge.textContent = 'Sender';
            elements.roleBadge.style.background = 'rgba(63, 185, 80, 0.2)';
            elements.roleBadge.style.color = 'var(--accent-green)';
            updateInstructions('sender');
            initializeSender();
        } else {
            elements.btnReceiver.classList.add('active', 'receiver');
            elements.receiverPanel.classList.remove('hidden');
            elements.senderPanel.classList.add('hidden');
            elements.fileDropZone.classList.add('hidden');
            elements.waitingForFile.classList.remove('hidden');
            elements.roleBadge.textContent = 'Receiver';
            elements.roleBadge.style.background = 'rgba(163, 113, 247, 0.2)';
            elements.roleBadge.style.color = 'var(--accent-purple)';
            updateInstructions('receiver');
            initializeReceiver();
        }
        
        log(`Role selected: ${role.toUpperCase()}`, 'info');
        updateStatus('waiting', 'Waiting for connection...');
    }

    /**
     * Updates instruction text based on role
     * @param {string} role - Current role
     */
    function updateInstructions(role) {
        if (role === 'sender') {
            elements.instructionsList.innerHTML = `
                <li>Wait for the connection offer to generate</li>
                <li>Copy the offer and send it to the receiver</li>
                <li>Wait for the receiver to send their answer</li>
                <li>Paste the answer and click "Accept Answer"</li>
                <li>Once connected, select a file to send</li>
            `;
        } else {
            elements.instructionsList.innerHTML = `
                <li>Get the connection offer from the sender</li>
                <li>Paste it in the text area and click "Accept Offer"</li>
                <li>Copy your generated answer</li>
                <li>Send the answer back to the sender</li>
                <li>Wait for the file transfer to begin</li>
            `;
        }
    }

    // ===========================================
    // WEBRTC INITIALIZATION
    // ===========================================

    /**
     * Creates and configures RTCPeerConnection
     * @returns {RTCPeerConnection} Configured peer connection
     */
    function createPeerConnection() {
        log('Creating peer connection...', 'info');
        
        const pc = new RTCPeerConnection(ICE_SERVERS);
        
        // Handle ICE candidate events
        pc.onicecandidate = (event) => {
            if (event.candidate) {
                log(`ICE candidate gathered: ${event.candidate.candidate.split(' ')[4] || 'relay'}`, 'info');
            } else {
                // ICE gathering complete - all candidates included in SDP
                iceGatheringComplete = true;
                log('ICE gathering complete', 'success');
                updateLocalDescription();
            }
        };
        
        // Handle ICE connection state changes
        pc.oniceconnectionstatechange = () => {
            log(`ICE connection state: ${pc.iceConnectionState}`, 'info');
            
            switch (pc.iceConnectionState) {
                case 'connected':
                case 'completed':
                    handleConnectionEstablished();
                    break;
                case 'disconnected':
                    updateStatus('warning', 'Connection interrupted');
                    log('Peer disconnected', 'warning');
                    break;
                case 'failed':
                    updateStatus('error', 'Connection failed');
                    log('Connection failed', 'error');
                    showToast('Connection failed. Please try again.', 'error');
                    break;
            }
        };
        
        // Handle connection state changes
        pc.onconnectionstatechange = () => {
            log(`Connection state: ${pc.connectionState}`, 'info');
        };
        
        return pc;
    }

    /**
     * Updates the local description textarea with SDP + ICE candidates
     */
    function updateLocalDescription() {
        if (!peerConnection || !peerConnection.localDescription) return;
        
        const description = {
            type: peerConnection.localDescription.type,
            sdp: peerConnection.localDescription.sdp
        };
        
        const textarea = currentRole === 'sender' ? elements.localOffer : elements.localAnswer;
        textarea.value = JSON.stringify(description);
        
        log(`Local ${description.type} ready for sharing`, 'success');
        showToast(`${description.type.charAt(0).toUpperCase() + description.type.slice(1)} is ready! Copy and share it.`, 'info');
    }

    /**
     * Initializes sender role - creates offer
     */
    async function initializeSender() {
        try {
            // Reset state
            iceGatheringComplete = false;
            
            peerConnection = createPeerConnection();
            
            // Create data channel with ordered delivery
            dataChannel = peerConnection.createDataChannel('fileTransfer', {
                ordered: true
            });
            
            setupDataChannel(dataChannel);
            
            // Create and set offer
            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);
            
            log('Offer created, gathering ICE candidates...', 'info');
            
        } catch (error) {
            log(`Failed to initialize sender: ${error.message}`, 'error');
            showToast('Failed to initialize. Please refresh and try again.', 'error');
        }
    }

    /**
     * Initializes receiver role - waits for offer
     */
    function initializeReceiver() {
        // Reset state
        iceGatheringComplete = false;
        
        peerConnection = createPeerConnection();
        
        // Handle incoming data channel
        peerConnection.ondatachannel = (event) => {
            log('Data channel received', 'success');
            dataChannel = event.channel;
            setupDataChannel(dataChannel);
        };
        
        log('Receiver initialized, waiting for offer...', 'info');
    }

    /**
     * Handles remote offer (receiver side)
     */
    async function handleRemoteOffer() {
        const offerText = elements.remoteOffer.value.trim();
        
        if (!offerText) {
            showToast('Please paste the offer first!', 'error');
            return;
        }
        
        try {
            const offer = JSON.parse(offerText);
            
            if (offer.type !== 'offer') {
                throw new Error('Invalid offer format');
            }
            
            log('Processing remote offer...', 'info');
            
            // Set remote description
            await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
            log('Remote offer accepted', 'success');
            
            // Create answer
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            
            log('Answer created, gathering ICE candidates...', 'info');
            
        } catch (error) {
            log(`Failed to process offer: ${error.message}`, 'error');
            showToast('Invalid offer format. Please check and try again.', 'error');
        }
    }

    /**
     * Handles remote answer (sender side)
     */
    async function handleRemoteAnswer() {
        const answerText = elements.remoteAnswer.value.trim();
        
        if (!answerText) {
            showToast('Please paste the answer first!', 'error');
            return;
        }
        
        try {
            const answer = JSON.parse(answerText);
            
            if (answer.type !== 'answer') {
                throw new Error('Invalid answer format');
            }
            
            log('Processing remote answer...', 'info');
            
            await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
            log('Remote answer accepted', 'success');
            
        } catch (error) {
            log(`Failed to process answer: ${error.message}`, 'error');
            showToast('Invalid answer format. Please check and try again.', 'error');
        }
    }

    /**
     * Handles successful connection establishment
     */
    function handleConnectionEstablished() {
        if (isConnected) return;
        isConnected = true;
        
        updateStatus('connected', 'Connected to peer');
        log('Peer connection established!', 'success');
        showToast('Connected successfully!', 'success');
        
        // Enable file selection for sender
        if (currentRole === 'sender') {
            elements.fileDropZone.classList.remove('disabled');
            
            // Show send button if file already selected
            if (selectedFile) {
                elements.sendButtonContainer.classList.remove('hidden');
            }
        }
        
        elements.transferBadge.textContent = 'Ready';
    }

    // ===========================================
    // DATA CHANNEL SETUP
    // ===========================================

    /**
     * Sets up data channel event handlers
     * @param {RTCDataChannel} channel - Data channel to configure
     */
    function setupDataChannel(channel) {
        // Use ArrayBuffer for binary data transfer
        channel.binaryType = 'arraybuffer';
        
        // Set buffer threshold for backpressure management
        channel.bufferedAmountLowThreshold = BUFFER_LOW_THRESHOLD;
        
        channel.onopen = () => {
            log('Data channel opened', 'success');
            handleConnectionEstablished();
        };
        
        channel.onclose = () => {
            log('Data channel closed', 'warning');
            updateStatus('waiting', 'Disconnected');
            isConnected = false;
        };
        
        channel.onerror = (error) => {
            log(`Data channel error: ${error.message || 'Unknown error'}`, 'error');
        };
        
        channel.onmessage = handleDataChannelMessage;
        
        // Backpressure handling - resume sending when buffer is low
        channel.onbufferedamountlow = () => {
            if (sendingInProgress && sendPaused) {
                sendPaused = false;
                log('Buffer cleared, resuming transfer...', 'info');
                continueSending();
            }
        };
    }

    // ===========================================
    // FILE HANDLING (DRAG & DROP)
    // ===========================================

    /**
     * Sets up file drop zone event listeners
     */
    function setupFileHandling() {
        const dropZone = elements.fileDropZone;
        const fileInput = elements.fileInput;
        
        // Click to select file
        dropZone.addEventListener('click', () => {
            if (!dropZone.classList.contains('disabled')) {
                fileInput.click();
            }
        });
        
        // Drag over
        dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            if (!dropZone.classList.contains('disabled')) {
                dropZone.classList.add('dragover');
            }
        });
        
        // Drag leave
        dropZone.addEventListener('dragleave', () => {
            dropZone.classList.remove('dragover');
        });
        
        // Drop file
        dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropZone.classList.remove('dragover');
            
            if (dropZone.classList.contains('disabled')) return;
            
            const files = e.dataTransfer.files;
            if (files.length > 0) {
                handleFileSelection(files[0]);
            }
        });
        
        // File input change
        fileInput.addEventListener('change', (e) => {
            if (e.target.files.length > 0) {
                handleFileSelection(e.target.files[0]);
            }
        });
    }

    /**
     * Handles file selection
     * @param {File} file - Selected file
     */
    function handleFileSelection(file) {
        selectedFile = file;
        
        // Update UI
        elements.fileDropZone.classList.add('has-file');
        elements.fileInfo.classList.add('visible');
        elements.fileTypeIcon.textContent = getFileIcon(file.type);
        elements.fileName.textContent = file.name;
        elements.fileMeta.textContent = `${formatBytes(file.size)} • ${file.type || 'Unknown type'}`;
        
        // Show send button if connected
        if (isConnected) {
            elements.sendButtonContainer.classList.remove('hidden');
        }
        
        log(`File selected: ${file.name} (${formatBytes(file.size)})`, 'info');
    }

    /**
     * Removes selected file
     */
    function removeFile() {
        selectedFile = null;
        elements.fileDropZone.classList.remove('has-file');
        elements.fileInfo.classList.remove('visible');
        elements.sendButtonContainer.classList.add('hidden');
        elements.fileInput.value = '';
        log('File removed', 'info');
    }

    // ===========================================
    // FILE TRANSFER - SENDER
    // ===========================================

    /**
     * Starts the file transfer process
     */
    async function startFileTransfer() {
        if (!selectedFile || !dataChannel || dataChannel.readyState !== 'open') {
            showToast('Cannot start transfer. Check connection and file.', 'error');
            return;
        }
        
        log(`Starting transfer: ${selectedFile.name}`, 'info');
        updateStatus('transferring', 'Transferring file...');
        elements.transferBadge.textContent = 'Sending';
        
        // Show progress UI
        elements.progressSection.classList.add('visible');
        elements.progressTitle.textContent = `Sending: ${selectedFile.name}`;
        elements.progressTotal.textContent = formatBytes(selectedFile.size);
        elements.sendButtonContainer.classList.add('hidden');
        elements.btnSendFile.disabled = true;
        
        // Reset progress bar
        elements.progressBar.style.width = '0%';
        elements.progressBar.classList.remove('completed');
        
        // Calculate total chunks
        totalChunks = Math.ceil(selectedFile.size / CHUNK_SIZE);
        currentChunkIndex = 0;
        transferStartTime = Date.now();
        lastProgressUpdate = transferStartTime;
        lastTransferredBytes = 0;
        
        // Send file metadata first
        const metadata = {
            type: 'metadata',
            name: selectedFile.name,
            size: selectedFile.size,
            mimeType: selectedFile.type,
            totalChunks: totalChunks
        };
        
        dataChannel.send(JSON.stringify(metadata));
        log(`Metadata sent: ${totalChunks} chunks`, 'info');
        
        // Start sending chunks
        sendingInProgress = true;
        sendPaused = false;
        sendNextChunk();
    }

    /**
     * Sends the next chunk of the file
     */
    function sendNextChunk() {
        if (!sendingInProgress || sendPaused) return;
        
        // Check if transfer is complete
        if (currentChunkIndex >= totalChunks) {
            finishSending();
            return;
        }
        
        // Check backpressure - pause if buffer is too full
        if (dataChannel.bufferedAmount > BUFFER_THRESHOLD) {
            sendPaused = true;
            log(`Backpressure detected at chunk ${currentChunkIndex + 1}/${totalChunks}, pausing...`, 'warning');
            return;
        }
        
        // Calculate chunk boundaries
        const start = currentChunkIndex * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, selectedFile.size);
        const chunk = selectedFile.slice(start, end);
        
        // Read and send chunk
        const reader = new FileReader();
        reader.onload = () => {
            if (!sendingInProgress) return;
            
            // Create header with chunk index (4 bytes, little-endian)
            const header = new ArrayBuffer(4);
            new DataView(header).setUint32(0, currentChunkIndex, true);
            
            // Combine header and chunk data
            const combined = new Uint8Array(4 + reader.result.byteLength);
            combined.set(new Uint8Array(header), 0);
            combined.set(new Uint8Array(reader.result), 4);
            
            dataChannel.send(combined.buffer);
            
            // Update progress
            currentChunkIndex++;
            updateSendProgress(end);
            
            // Schedule next chunk (using setTimeout to prevent stack overflow)
            if (dataChannel.bufferedAmount <= BUFFER_THRESHOLD) {
                setTimeout(sendNextChunk, 0);
            } else {
                sendPaused = true;
            }
        };
        
        reader.onerror = () => {
            log(`Error reading file chunk ${currentChunkIndex}`, 'error');
            showToast('Error reading file. Transfer aborted.', 'error');
            sendingInProgress = false;
        };
        
        reader.readAsArrayBuffer(chunk);
    }

    /**
     * Continues sending after backpressure release
     */
    function continueSending() {
        if (sendingInProgress && !sendPaused) {
            sendNextChunk();
        }
    }

    /**
     * Updates sending progress UI
     * @param {number} bytesSent - Total bytes sent so far
     */
    function updateSendProgress(bytesSent) {
        const percentage = Math.round((bytesSent / selectedFile.size) * 100);
        const now = Date.now();
        
        // Update progress bar
        elements.progressBar.style.width = `${percentage}%`;
        elements.progressStats.textContent = `${percentage}%`;
        elements.progressTransferred.textContent = formatBytes(bytesSent);
        
        // Calculate speed and ETA (update every 200ms to avoid flickering)
        if (now - lastProgressUpdate >= 200) {
            const timeDelta = (now - lastProgressUpdate) / 1000;
            const bytesDelta = bytesSent - lastTransferredBytes;
            const speed = bytesDelta / timeDelta;
            
            const remainingBytes = selectedFile.size - bytesSent;
            const eta = speed > 0 ? remainingBytes / speed : 0;
            
            elements.progressSpeed.textContent = formatBytes(speed) + '/s';
            elements.progressETA.textContent = formatTime(eta);
            
            lastProgressUpdate = now;
            lastTransferredBytes = bytesSent;
        }
    }

    /**
     * Finishes the sending process
     */
    function finishSending() {
        sendingInProgress = false;
        
        // Send completion signal
        dataChannel.send(JSON.stringify({ type: 'complete' }));
        
        // Update UI
        elements.progressBar.style.width = '100%';
        elements.progressBar.classList.add('completed');
        elements.progressStats.textContent = '100%';
        elements.progressTransferred.textContent = formatBytes(selectedFile.size);
        elements.progressSpeed.textContent = '--';
        elements.progressETA.textContent = '00:00';
        elements.progressTitle.textContent = 'Transfer Complete!';
        
        const duration = (Date.now() - transferStartTime) / 1000;
        const avgSpeed = selectedFile.size / duration;
        
        updateStatus('completed', 'Transfer complete!');
        elements.transferBadge.textContent = 'Complete';
        
        log(`Transfer complete! Duration: ${formatTime(duration)}, Avg speed: ${formatBytes(avgSpeed)}/s`, 'success');
        showToast('File sent successfully!', 'success');
    }

    // ===========================================
    // FILE TRANSFER - RECEIVER
    // ===========================================

    /**
     * Handles incoming data channel messages
     * @param {MessageEvent} event - Message event
     */
    function handleDataChannelMessage(event) {
        // Handle text messages (metadata, control)
        if (typeof event.data === 'string') {
            try {
                const message = JSON.parse(event.data);
                
                if (message.type === 'metadata') {
                    handleFileMetadata(message);
                } else if (message.type === 'complete') {
                    handleTransferComplete();
                }
            } catch (e) {
                log(`Failed to parse message: ${e.message}`, 'error');
            }
            return;
        }
        
        // Handle binary data (file chunks)
        handleFileChunk(event.data);
    }

    /**
     * Handles incoming file metadata
     * @param {Object} metadata - File metadata object
     */
    function handleFileMetadata(metadata) {
        receivedFileInfo = metadata;
        receivedChunks = new Array(metadata.totalChunks);
        receivedBytes = 0;
        transferStartTime = Date.now();
        lastProgressUpdate = transferStartTime;
        lastTransferredBytes = 0;
        
        log(`Receiving file: ${metadata.name} (${formatBytes(metadata.size)}, ${metadata.totalChunks} chunks)`, 'info');
        
        // Update UI
        elements.waitingForFile.classList.add('hidden');
        elements.progressSection.classList.add('visible');
        elements.progressTitle.textContent = `Receiving: ${metadata.name}`;
        elements.progressTotal.textContent = formatBytes(metadata.size);
        elements.transferBadge.textContent = 'Receiving';
        
        // Reset progress bar
        elements.progressBar.style.width = '0%';
        elements.progressBar.classList.remove('completed');
        
        updateStatus('transferring', 'Receiving file...');
    }

    /**
     * Handles incoming file chunk
     * @param {ArrayBuffer} data - Chunk data with header
     */
    function handleFileChunk(data) {
        if (!receivedFileInfo) {
            log('Received chunk before metadata', 'error');
            return;
        }
        
        // Extract chunk index from header (first 4 bytes, little-endian)
        const view = new DataView(data);
        const chunkIndex = view.getUint32(0, true);
        
        // Extract actual chunk data (skip 4-byte header)
        const chunkData = data.slice(4);
        
        // Store chunk
        receivedChunks[chunkIndex] = chunkData;
        receivedBytes += chunkData.byteLength;
        
        // Update progress
        updateReceiveProgress();
    }

    /**
     * Updates receiving progress UI
     */
    function updateReceiveProgress() {
        const percentage = Math.round((receivedBytes / receivedFileInfo.size) * 100);
        const now = Date.now();
        
        // Update progress bar
        elements.progressBar.style.width = `${percentage}%`;
        elements.progressStats.textContent = `${percentage}%`;
        elements.progressTransferred.textContent = formatBytes(receivedBytes);
        
        // Calculate speed and ETA
        if (now - lastProgressUpdate >= 200) {
            const timeDelta = (now - lastProgressUpdate) / 1000;
            const bytesDelta = receivedBytes - lastTransferredBytes;
            const speed = timeDelta > 0 ? bytesDelta / timeDelta : 0;
            
            const remainingBytes = receivedFileInfo.size - receivedBytes;
            const eta = speed > 0 ? remainingBytes / speed : 0;
            
            elements.progressSpeed.textContent = formatBytes(speed) + '/s';
            elements.progressETA.textContent = formatTime(eta);
            
            lastProgressUpdate = now;
            lastTransferredBytes = receivedBytes;
        }
    }

    /**
     * Handles transfer completion signal
     */
    function handleTransferComplete() {
        log('Transfer complete signal received', 'success');
        
        // Reassemble file from chunks
        const blob = new Blob(receivedChunks, { type: receivedFileInfo.mimeType });
        
        // Create download link
        const url = URL.createObjectURL(blob);
        elements.downloadLink.href = url;
        elements.downloadLink.download = receivedFileInfo.name;
        elements.downloadInfo.textContent = `${receivedFileInfo.name} • ${formatBytes(receivedFileInfo.size)}`;
        
        // Update UI
        elements.progressBar.style.width = '100%';
        elements.progressBar.classList.add('completed');
        elements.progressStats.textContent = '100%';
        elements.progressTransferred.textContent = formatBytes(receivedFileInfo.size);
        elements.progressSpeed.textContent = '--';
        elements.progressETA.textContent = '00:00';
        elements.progressTitle.textContent = 'Transfer Complete!';
        
        elements.downloadSection.classList.add('visible');
        
        const duration = (Date.now() - transferStartTime) / 1000;
        const avgSpeed = receivedFileInfo.size / duration;
        
        updateStatus('completed', 'File received!');
        elements.transferBadge.textContent = 'Complete';
        
        log(`File received! Duration: ${formatTime(duration)}, Avg speed: ${formatBytes(avgSpeed)}/s`, 'success');
        showToast('File received! Click to download.', 'success');
        
        // Clean up memory
        receivedChunks = [];
    }

    // ===========================================
    // INITIALIZATION
    // ===========================================

    /**
     * Initialize application on DOM ready
     */
    function init() {
        log('P2P File Share application initialized', 'info');
        log(`Configuration: Chunk size ${formatBytes(CHUNK_SIZE)}, Buffer threshold ${formatBytes(BUFFER_THRESHOLD)}`, 'info');
        
        // Check WebRTC support
        if (!window.RTCPeerConnection) {
            log('WebRTC not supported in this browser!', 'error');
            showToast('Your browser does not support WebRTC. Please use a modern browser.', 'error');
            updateStatus('error', 'WebRTC not supported');
            return;
        }
        
        log('WebRTC support detected ✓', 'success');
        
        // Setup file handling
        setupFileHandling();
        
        updateStatus('idle', 'Select a role to begin');
    }

    // Run initialization when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // ===========================================
    // PUBLIC API
    // ===========================================
    
    return {
        selectRole,
        copyToClipboard,
        handleRemoteOffer,
        handleRemoteAnswer,
        startFileTransfer,
        removeFile,
        toggleLog
    };

})();