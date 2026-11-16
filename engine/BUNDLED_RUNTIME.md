# Bundled Python runtime

Windows builds include the CPython 3.14.10 x64 embeddable runtime from Python.org. The archive SHA-256 is `90905e64a840557d8c1bc4f5b74db3d7ee85e3ffb217611cac1c7813acea4159`.

The `python314._pth` file includes the neighboring `vendor` directory. `vendor` contains the Windows CPython 3.14 wheels for MetaTrader5 5.0.6231 and NumPy 2.5.4. Update `requirements-mt5.txt` and refresh this folder together when updating either dependency. The app starts this interpreter directly; it does not need a separate Python installation or pip.

The bundled Python runtime is x64 Windows. The MetaTrader 5 desktop terminal must be installed and logged in separately because the Python integration attaches to that terminal.
