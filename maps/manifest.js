// マップ一覧(常時読み込む軽量な定義のみ)。マップ選択UIが出来た際にはこの配列を表示に使う。
// 現時点ではマップが神社1つのみのため、controller.html側は決め打ちでid==='shrine'を読む。
(function(global){
  "use strict";
  global.GHOST_MAP_MANIFEST=[
    {id:'shrine', title:'神社', file:'maps/shrine.js'}
  ];
})(window);
