import React, { useRef } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';

export default function PairingScanner({ visible, onClose, onScanned, message }) {
  const [permission, requestPermission] = useCameraPermissions();
  const consumedRef = useRef(false);
  if (!visible) {
    consumedRef.current = false;
    return null;
  }
  const scan = async ({ data }) => {
    if (consumedRef.current) return;
    consumedRef.current = true;
    // false means the camera decoded a QR but the app rejected its contents;
    // allow a second scan without forcing the user to reopen the modal.
    const accepted = await onScanned(data);
    if (!accepted) consumedRef.current = false;
  };
  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <View style={styles.page}>
        <Text style={styles.title}>Scan laptop QR</Text>
        <Text style={styles.copy}>Camera ready. Point it at the QR shown by Start LectureAI Laptop AI. If this message stays visible, Camera could not read a QR code yet. The QR contains only the private laptop address and one-time pairing code — never your authorization token.</Text>
        {permission?.granted ? <CameraView style={styles.camera} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={scan} /> : <Pressable style={styles.button} onPress={() => void requestPermission()}><Text style={styles.buttonText}>Allow camera to scan QR</Text></Pressable>}
        {message ? <Text style={styles.message}>{message}</Text> : null}
        <Pressable style={styles.cancel} onPress={onClose}><Text style={styles.cancelText}>Close scanner</Text></Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#08121f', padding: 24, justifyContent: 'center', gap: 16 },
  title: { color: '#fff', fontSize: 25, fontWeight: '800' },
  copy: { color: '#c9d7e6', fontSize: 16, lineHeight: 22 },
  camera: { height: 340, borderRadius: 18, overflow: 'hidden' },
  button: { backgroundColor: '#55d6be', padding: 16, borderRadius: 12, alignItems: 'center' },
  buttonText: { color: '#06201d', fontWeight: '800' },
  cancel: { padding: 14, alignItems: 'center' },
  cancelText: { color: '#a9c4df', fontWeight: '700' },
  message: { color: '#ffd58d', textAlign: 'center', lineHeight: 20 },
});
