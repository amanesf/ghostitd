( function () {

	/**
 *	Simplification Geometry Modifier
 *    - based on code and technique
 *	  - by Stan Melax in 1998
 *	  - Progressive Mesh type Polygon Reduction Algorithm
 *    - http://www.melax.com/polychop/
 */

	const _cb = new THREE.Vector3(),
		_ab = new THREE.Vector3();

	class SimplifyModifier {

		constructor() {

			if ( THREE.BufferGeometryUtils === undefined ) {

				throw 'THREE.SimplifyModifier relies on THREE.BufferGeometryUtils';

			}

		}

		// ★2026-07-12改変(3DtoolJS): 第3引数weights(Float32Array、geometryの
		// 元の頂点順に対応、省略時は全て1)を追加した。標準のcomputeEdgeCollapseCost
		// は辺の絶対長×曲率のみで判定するため、体+全アクセサリーを1つの
		// メッシュとして間引く運用(js/carving.jsのdecimateMesh参照)では、体より
		// 絶対的に小さい/細いアクセサリー(例: 房状の髪飾り)の辺が「短い=安い」と
		// 判定されて優先的に潰され、体側がほとんど手つかずのまま先に丸ごと
		// 単純化されてしまう不具合があった(ユーザー指摘「ツインテールの造形が
		// 粗い」「間引き前は綺麗だった」で原因特定)。weightsは呼び出し側
		// (decimateMesh)でパーツごとの特徴的スケール比から計算し、小さい
		// パーツの頂点ほど大きな重みを持たせることで、間引きが絶対誤差ではなく
		// パーツごとの相対的なディテールを保つよう補正する。
		// ★2026-07-12改変(3DtoolJS、SIMPLIFY_DECIMATE_PLAN.md): 第4引数maxCost
		// (省略可)を追加した。指定すると、次に潰す辺のコストがmaxCostを超えた
		// 時点でcountに達していなくても間引きを打ち切る(呼び出し側decimateMesh
		// が「目標頂点数」ではなく「間引きの強さ(誤差閾値)」でUIを持てるように
		// するため)。
		modify( geometry, count, weights, maxCost ) {

			if ( geometry.isGeometry === true ) {

				console.error( 'THREE.SimplifyModifier no longer supports Geometry. Use THREE.BufferGeometry instead.' );
				return;

			}

			geometry = geometry.clone();
			const attributes = geometry.attributes; // this modifier can only process indexed and non-indexed geomtries with a position attribute

			for ( const name in attributes ) {

				if ( name !== 'position' ) geometry.deleteAttribute( name );

			}

			if ( weights ) {

				geometry.setAttribute( 'weight', new THREE.Float32BufferAttribute( weights, 1 ) );

			}

			geometry = THREE.BufferGeometryUtils.mergeVertices( geometry ); //
			// put data of original geometry in different data structures
			//

			const vertices = [];
			const faces = []; // add vertices

			const positionAttribute = geometry.getAttribute( 'position' );
			const weightAttribute = geometry.getAttribute( 'weight' );

			for ( let i = 0; i < positionAttribute.count; i ++ ) {

				const v = new THREE.Vector3().fromBufferAttribute( positionAttribute, i );
				const vertex = new Vertex( v, i );
				if ( weightAttribute ) vertex.weight = weightAttribute.getX( i );
				vertices.push( vertex );

			} // add faces


			let index = geometry.getIndex();

			// ★2026-07-12調査(3DtoolJS、SIMPLIFY_DECIMATE_PLAN.md): 実サンプル
			// (体+全アクセサリー統合、163,982頂点)で"Cannot read properties of
			// undefined (reading 'hasVertex')"が発生する直接原因を特定した。
			// 直前のmergeVertices()が座標の一致する頂点を溶接するが、彫刻元の
			// メッシュにはパーツの継ぎ目付近に重複座標の頂点が一定数含まれる
			// (実測: 163,982頂点中2,507頂点が重複、溶接後4,622面が縮退)。
			// 溶接後にindexの3頂点のうち2つ以上が同じ頂点を指す縮退三角形が
			// できると、Triangleのコンストラクタがその頂点の.faces配列に同じ
			// 三角形を2回push してしまい(v1===v2ならv1.faces/v2.facesへの
			// pushが同じ配列に対して2回走る)、collapse()内の「u.facesを後ろから
			// 辿って1つずつ安全に取り除く」前提が崩れて配列外を読み、
			// undefinedになる。縮退三角形はそもそも面積0で意味を持たないため、
			// 半エッジ構造を組む前にここで除外する。
			if ( index !== null ) {

				for ( let i = 0; i < index.count; i += 3 ) {

					const a = index.getX( i );
					const b = index.getX( i + 1 );
					const c = index.getX( i + 2 );
					if ( a === b || b === c || a === c ) continue;
					const triangle = new Triangle( vertices[ a ], vertices[ b ], vertices[ c ], a, b, c );
					faces.push( triangle );

				}

			} else {

				for ( let i = 0; i < positionAttribute.count; i += 3 ) {

					const a = i;
					const b = i + 1;
					const c = i + 2;
					if ( a === b || b === c || a === c ) continue;
					const triangle = new Triangle( vertices[ a ], vertices[ b ], vertices[ c ], a, b, c );
					faces.push( triangle );

				}

			} // compute all edge collapse costs


			// ★2026-07-12改変(3DtoolJS): minimumCostEdge()は毎回vertices配列を
			// O(n)で線形走査していたため、間引き数×頂点数のO(n×削除数)となり
			// 大規模メッシュで実用的な時間で終わらなかった(163,982頂点→
			// 10,000頂点の実測で約190秒)。二分ヒープ(CostHeap、下記)に置き換え、
			// 抽出をO(log n)にする(実測で約91秒に短縮)。
			const heap = new CostHeap();

			for ( let i = 0, il = vertices.length; i < il; i ++ ) {

				computeEdgeCostAtVertex( vertices[ i ] );
				heap.push( vertices[ i ] );

			}

			let nextVertex;
			let z = count;

			while ( z -- ) {

				nextVertex = heap.popValid();

				if ( ! nextVertex ) {

					console.log( 'THREE.SimplifyModifier: No next vertex' );
					break;

				}

				if ( maxCost !== undefined && nextVertex.collapseCost > maxCost ) break;

				collapse( vertices, faces, nextVertex, nextVertex.collapseNeighbor, heap );

			} //


			const simplifiedGeometry = new THREE.BufferGeometry();
			const position = [];
			index = []; //

			for ( let i = 0; i < vertices.length; i ++ ) {

				const vertex = vertices[ i ].position;
				position.push( vertex.x, vertex.y, vertex.z );

			} //


			for ( let i = 0; i < faces.length; i ++ ) {

				const face = faces[ i ];
				const a = vertices.indexOf( face.v1 );
				const b = vertices.indexOf( face.v2 );
				const c = vertices.indexOf( face.v3 );
				index.push( a, b, c );

			} //


			simplifiedGeometry.setAttribute( 'position', new THREE.Float32BufferAttribute( position, 3 ) );
			simplifiedGeometry.setIndex( index );
			return simplifiedGeometry;

		}

	}

	function pushIfUnique( array, object ) {

		if ( array.indexOf( object ) === - 1 ) array.push( object );

	}

	function removeFromArray( array, object ) {

		var k = array.indexOf( object );
		if ( k > - 1 ) array.splice( k, 1 );

	}

	function computeEdgeCollapseCost( u, v ) {

		// if we collapse edge uv by moving u to v then how
		// much different will the model change, i.e. the "error".
		const edgelength = v.position.distanceTo( u.position );
		let curvature = 0;
		const sideFaces = []; // find the "sides" triangles that are on the edge uv

		for ( let i = 0, il = u.faces.length; i < il; i ++ ) {

			const face = u.faces[ i ];

			if ( face.hasVertex( v ) ) {

				sideFaces.push( face );

			}

		} // use the triangle facing most away from the sides
		// to determine our curvature term


		for ( let i = 0, il = u.faces.length; i < il; i ++ ) {

			let minCurvature = 1;
			const face = u.faces[ i ];

			for ( let j = 0; j < sideFaces.length; j ++ ) {

				const sideFace = sideFaces[ j ]; // use dot product of face normals.

				const dotProd = face.normal.dot( sideFace.normal );
				minCurvature = Math.min( minCurvature, ( 1.001 - dotProd ) / 2 );

			}

			curvature = Math.max( curvature, minCurvature );

		} // crude approach in attempt to preserve borders
		// though it seems not to be totally correct


		const borders = 0;

		if ( sideFaces.length < 2 ) {

			// we add some arbitrary cost for borders,
			// borders += 10;
			curvature = 1;

		}

		// ★2026-07-12改変(3DtoolJS): u/vのweight(既定1)を掛けて、絶対的な辺長
		// だけでなく呼び出し側が指定したパーツ相対スケールも考慮する。
		// 境界(u/vで別パーツ)の辺は、より保護したい側(大きいweight)を優先する。
		const amt = edgelength * curvature * Math.max( u.weight, v.weight ) + borders;
		return amt;

	}

	function computeEdgeCostAtVertex( v ) {

		// compute the edge collapse cost for all edges that start
		// from vertex v.  Since we are only interested in reducing
		// the object by selecting the min cost edge at each step, we
		// only cache the cost of the least cost edge at this vertex
		// (in member variable collapse) as well as the value of the
		// cost (in member variable collapseCost).
		if ( v.neighbors.length === 0 ) {

			// collapse if no neighbors.
			v.collapseNeighbor = null;
			v.collapseCost = - 0.01;
			return;

		}

		v.collapseCost = 100000;
		v.collapseNeighbor = null; // search all neighboring edges for "least cost" edge

		for ( let i = 0; i < v.neighbors.length; i ++ ) {

			const collapseCost = computeEdgeCollapseCost( v, v.neighbors[ i ] );

			if ( ! v.collapseNeighbor ) {

				v.collapseNeighbor = v.neighbors[ i ];
				v.collapseCost = collapseCost;
				v.minCost = collapseCost;
				v.totalCost = 0;
				v.costCount = 0;

			}

			v.costCount ++;
			v.totalCost += collapseCost;

			if ( collapseCost < v.minCost ) {

				v.collapseNeighbor = v.neighbors[ i ];
				v.minCost = collapseCost;

			}

		} // we average the cost of collapsing at this vertex


		v.collapseCost = v.totalCost / v.costCount; // v.collapseCost = v.minCost;

	}

	function removeVertex( v, vertices ) {

		console.assert( v.faces.length === 0 );

		while ( v.neighbors.length ) {

			const n = v.neighbors.pop();
			removeFromArray( n.neighbors, v );

		}

		removeFromArray( vertices, v );
		v.__removed = true; // CostHeap.popValid()が既に消えた頂点の古いエントリを読み捨てるためのフラグ

	}

	function removeFace( f, faces ) {

		removeFromArray( faces, f );
		if ( f.v1 ) removeFromArray( f.v1.faces, f );
		if ( f.v2 ) removeFromArray( f.v2.faces, f );
		if ( f.v3 ) removeFromArray( f.v3.faces, f ); // TODO optimize this!

		const vs = [ f.v1, f.v2, f.v3 ];

		for ( let i = 0; i < 3; i ++ ) {

			const v1 = vs[ i ];
			const v2 = vs[ ( i + 1 ) % 3 ];
			if ( ! v1 || ! v2 ) continue;
			v1.removeIfNonNeighbor( v2 );
			v2.removeIfNonNeighbor( v1 );

		}

	}

	function collapse( vertices, faces, u, v, heap ) {

		// u and v are pointers to vertices of an edge
		// Collapse the edge uv by moving vertex u onto v
		if ( ! v ) {

			// u is a vertex all by itself so just delete it..
			removeVertex( u, vertices );
			return;

		}

		const tmpVertices = [];

		for ( let i = 0; i < u.neighbors.length; i ++ ) {

			tmpVertices.push( u.neighbors[ i ] );

		} // delete triangles on edge uv:


		for ( let i = u.faces.length - 1; i >= 0; i -- ) {

			if ( u.faces[ i ].hasVertex( v ) ) {

				removeFace( u.faces[ i ], faces );

			}

		} // update remaining triangles to have v instead of u


		for ( let i = u.faces.length - 1; i >= 0; i -- ) {

			u.faces[ i ].replaceVertex( u, v );

		}

		removeVertex( u, vertices ); // recompute the edge collapse costs in neighborhood

		for ( let i = 0; i < tmpVertices.length; i ++ ) {

			computeEdgeCostAtVertex( tmpVertices[ i ] );
			heap.push( tmpVertices[ i ] );

		}

	}

	// ★2026-07-12追加(3DtoolJS): modify()内コメント参照。costは頂点の
	// collapseCostが再計算されるたびに変わるため、通常の二分ヒープにある
	// decrease-key操作は実装せず、遅延削除方式を採る: 再計算のたびに
	// push()で新しいエントリを積み(古いエントリはヒープ内に残ったまま)、
	// pop側のpopValid()で頂点の現在のcollapseCostに対応する最新の
	// エントリ(ver一致)だけを採用し、古い/既に削除済み(__removed)の
	// エントリは読み捨てる。
	class CostHeap {

		constructor() {

			this.arr = [];

		}

		push( v ) {

			v.__heapVer = ( v.__heapVer || 0 ) + 1;
			const entry = { v: v, cost: v.collapseCost, ver: v.__heapVer };
			const a = this.arr;
			a.push( entry );
			let i = a.length - 1;

			while ( i > 0 ) {

				const p = ( i - 1 ) >> 1;
				if ( a[ p ].cost <= a[ i ].cost ) break;
				const t = a[ p ]; a[ p ] = a[ i ]; a[ i ] = t;
				i = p;

			}

		}

		popValid() {

			const a = this.arr;

			while ( a.length ) {

				const top = a[ 0 ];
				const last = a.pop();

				if ( a.length ) {

					a[ 0 ] = last;
					let i = 0;
					const n = a.length;

					while ( true ) {

						let l = 2 * i + 1, r = 2 * i + 2, m = i;
						if ( l < n && a[ l ].cost < a[ m ].cost ) m = l;
						if ( r < n && a[ r ].cost < a[ m ].cost ) m = r;
						if ( m === i ) break;
						const t = a[ m ]; a[ m ] = a[ i ]; a[ i ] = t;
						i = m;

					}

				}

				if ( ! top.v.__removed && top.v.__heapVer === top.ver ) return top.v;

			}

			return undefined;

		}

	} // we use a triangle class to represent structure of face slightly differently


	class Triangle {

		constructor( v1, v2, v3, a, b, c ) {

			this.a = a;
			this.b = b;
			this.c = c;
			this.v1 = v1;
			this.v2 = v2;
			this.v3 = v3;
			this.normal = new THREE.Vector3();
			this.computeNormal();
			v1.faces.push( this );
			v1.addUniqueNeighbor( v2 );
			v1.addUniqueNeighbor( v3 );
			v2.faces.push( this );
			v2.addUniqueNeighbor( v1 );
			v2.addUniqueNeighbor( v3 );
			v3.faces.push( this );
			v3.addUniqueNeighbor( v1 );
			v3.addUniqueNeighbor( v2 );

		}

		computeNormal() {

			const vA = this.v1.position;
			const vB = this.v2.position;
			const vC = this.v3.position;

			_cb.subVectors( vC, vB );

			_ab.subVectors( vA, vB );

			_cb.cross( _ab ).normalize();

			this.normal.copy( _cb );

		}

		hasVertex( v ) {

			return v === this.v1 || v === this.v2 || v === this.v3;

		}

		replaceVertex( oldv, newv ) {

			if ( oldv === this.v1 ) this.v1 = newv; else if ( oldv === this.v2 ) this.v2 = newv; else if ( oldv === this.v3 ) this.v3 = newv;
			removeFromArray( oldv.faces, this );
			newv.faces.push( this );
			oldv.removeIfNonNeighbor( this.v1 );
			this.v1.removeIfNonNeighbor( oldv );
			oldv.removeIfNonNeighbor( this.v2 );
			this.v2.removeIfNonNeighbor( oldv );
			oldv.removeIfNonNeighbor( this.v3 );
			this.v3.removeIfNonNeighbor( oldv );
			this.v1.addUniqueNeighbor( this.v2 );
			this.v1.addUniqueNeighbor( this.v3 );
			this.v2.addUniqueNeighbor( this.v1 );
			this.v2.addUniqueNeighbor( this.v3 );
			this.v3.addUniqueNeighbor( this.v1 );
			this.v3.addUniqueNeighbor( this.v2 );
			this.computeNormal();

		}

	}

	class Vertex {

		constructor( v, id ) {

			this.position = v;
			this.id = id; // old index id
			this.weight = 1; // ★2026-07-12改変(3DtoolJS): computeEdgeCollapseCost参照

			this.faces = []; // faces vertex is connected

			this.neighbors = []; // neighbouring vertices aka "adjacentVertices"
			// these will be computed in computeEdgeCostAtVertex()

			this.collapseCost = 0; // cost of collapsing this vertex, the less the better. aka objdist

			this.collapseNeighbor = null; // best candinate for collapsing

		}

		addUniqueNeighbor( vertex ) {

			pushIfUnique( this.neighbors, vertex );

		}

		removeIfNonNeighbor( n ) {

			const neighbors = this.neighbors;
			const faces = this.faces;
			const offset = neighbors.indexOf( n );
			if ( offset === - 1 ) return;

			for ( let i = 0; i < faces.length; i ++ ) {

				if ( faces[ i ].hasVertex( n ) ) return;

			}

			neighbors.splice( offset, 1 );

		}

	}

	THREE.SimplifyModifier = SimplifyModifier;

} )();
