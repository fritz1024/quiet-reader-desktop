module.exports = {
  content: ['./app/index.html'],
  theme: {
    extend: {
      colors: {
        ink: '#202827',
        muted: '#7b8581',
        line: '#e4e7e2',
        paper: '#fffefa',
        shell: '#f7f7f4',
        teal: { DEFAULT: '#1e756c', dark: '#155b54', soft: '#e1f1ed' },
        coral: { DEFAULT: '#cf6b4f', soft: '#f8e8e2' }
      },
      boxShadow: {
        soft: '0 16px 50px rgba(31, 43, 40, .08)',
        popover: '0 18px 55px rgba(25, 40, 37, .16)'
      },
      fontFamily: {
        sans: ['Inter', 'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', 'sans-serif'],
        serif: ['Noto Serif SC', 'Source Han Serif CN', 'Songti SC', 'SimSun', 'serif']
      }
    }
  }
};
