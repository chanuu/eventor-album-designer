# Models

Both are built into the app and run on the studio's own computer. No photo leaves it to be checked.

| File | What it does | Source | Licence |
|---|---|---|---|
| `face_detection_yunet_2023mar.onnx` | Finds faces and the centre of each eye | [OpenCV Zoo, YuNet](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet), by Shiqi Yu | MIT, see `LICENSE-yunet.txt` |
| `face_landmarks.onnx` | Traces 478 points on a face, including both eyelids | Google MediaPipe Face Mesh V2, converted to ONNX by [QtMeshEditor](https://huggingface.co/fernandotonon/QtMeshEditor-facemesh-onnx) | Apache 2.0, see `LICENSE-apache-2.0.txt` |

Eyes count as closed from the eye aspect ratio of Soukupová and Čech (2016): the eyelid gap measured
against the eye's width.
